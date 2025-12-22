import { getBearerToken, validateJWT } from "../auth";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { randomBytes } from "crypto";
import path from "path";
import { uploadVideoToS3, generatePresignedURL } from "../s3";

import { type ApiConfig } from "../config";
import { type BunRequest } from "bun";

const MAX_UPLOAD_SIZE = 1 << 30; // 1 GB
const ALLOWED_THUMBNAIL_TYPES = ["video/mp4"];

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError(
      "You do not have permission to modify this video"
    );
  }

  const formData = await req.formData();
  const file = formData.get("video");

  if (!(file instanceof File)) {
    throw new BadRequestError("No video file provided");
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file is too large (max 1 GB)");
  }

  const mediaType = file.type;
  if (!ALLOWED_THUMBNAIL_TYPES.includes(mediaType)) {
    throw new BadRequestError("Unsupported thumbnail file type");
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const randomString = randomBytes(32).toString("base64url");
  const tempFileName = `${randomString}.${mediaType.split("/")[1]}`;
  const tempFilepath = path.join(cfg.assetsRoot, tempFileName);

  let processedFilepath = "";
  try {
    await Bun.write(tempFilepath, buffer);
    const aspectRatio = await getVideoAspectRatio(tempFilepath);
    console.log(
      "uploading video",
      `${aspectRatio}/${tempFileName}`,
      "by user",
      userID
    );

    processedFilepath = await processVideoForFastStart(tempFilepath);

    await uploadVideoToS3(
      cfg,
      `${aspectRatio}/${processedFilepath}`,
      processedFilepath,
      "video/mp4"
    );

    //const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${aspectRatio}/${processedFilepath}`;
    const videoURL = `${aspectRatio}/${processedFilepath}`;
    console.log("Uploaded video to S3:", videoURL);
    video.videoURL = videoURL;
    updateVideo(cfg.db, video);

    return respondWithJSON(200, await dbVideoToSignedVideo(cfg, video));
  } finally {
    try {
      if (await Bun.file(tempFilepath).exists()) {
        await Bun.file(tempFilepath).delete();
        console.log("Deleted temp video file");
      }
      if (await Bun.file(processedFilepath).exists()) {
        await Bun.file(processedFilepath).delete();
        console.log("Deleted processed video file");
      }
    } catch (err) {
      console.log("Failed to delete temp video file:", err);
    }
  }
}

async function getVideoAspectRatio(filepath: string) {
  const result = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      "-show_streams",
      filepath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(result.stdout).text();
  const stderr = await new Response(result.stderr).text();

  const exitCode = await result.exited;
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed with exit code ${exitCode}: ${stderr}`);
  }

  const data = JSON.parse(stdout);
  const { width, height } = data.streams[0];

  const ratio = width / height;
  const aspectRatio =
    Math.abs(ratio - 16 / 9) < 0.01
      ? "landscape"
      : Math.abs(ratio - 9 / 16) < 0.01
      ? "portrait"
      : "other";

  return aspectRatio;
}

async function processVideoForFastStart(inputFilePath: string) {
  let outputFilePath = inputFilePath + ".processed.mp4";
  const result = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stderr = await new Response(result.stderr).text();

  const exitCode = await result.exited;
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed with exit code ${exitCode}: ${stderr}`);
  }
  return outputFilePath;
}

export async function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  if (!video.videoURL) {
    return video;
  }
  console.log("signing key:", video.videoURL);

  video.videoURL = await generatePresignedURL(cfg, video.videoURL, 5 * 60);
  return video;
}
