import { getBearerToken, validateJWT } from "../auth";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "crypto";
import path from "path";
import { uploadVideoToS3 } from "../s3";

import { type ApiConfig } from "../config";
import { type BunRequest, type S3File } from "bun";
import { fstat } from "fs";

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

  console.log("uploading video", videoId, "by user", userID);

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
  const key = `${randomString}.${mediaType.split("/")[1]}`;
  const tempFilepath = path.join(cfg.assetsRoot, key);

  try {
    await Bun.write(tempFilepath, buffer);

    await uploadVideoToS3(cfg, key, tempFilepath, "video/mp4");

    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    console.log("Uploaded video to S3:", videoURL);
    video.videoURL = videoURL;
    updateVideo(cfg.db, video);

    return respondWithJSON(200, video);
  } finally {
    try {
      if (await Bun.file(tempFilepath).exists()) {
        await Bun.file(tempFilepath).delete();
        console.log("Deleted temp video file");
      }
    } catch (err) {
      console.log("Failed to delete temp video file:", err);
    }
  }
}
