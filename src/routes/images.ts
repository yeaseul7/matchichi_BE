import {Router} from "express";
import multer from "multer";
import {
  getImageBucketName,
  uploadImageBufferToSupabaseStorage,
  uploadImageUrlToSupabaseStorage,
} from "../shared/supabaseImageUpload.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {fileSize: 10 * 1024 * 1024, files: 1},
});

// eslint-disable-next-line new-cap
export const imagesRouter = Router();

imagesRouter.post("/api/images/upload", upload.single("file"), async (
  req,
  res
) => {
  const file = req.file;
  const imageUrl = typeof req.body?.imageUrl === "string" ?
    req.body.imageUrl.trim() : "";
  const publicId = typeof req.body?.publicId === "string" ?
    req.body.publicId.trim() : undefined;
  const folder = typeof req.body?.folder === "string" ?
    req.body.folder.trim() : "";

  if (!file && (!imageUrl || !imageUrl.startsWith("http"))) {
    res.status(400).json({
      ok: false,
      error: "업로드할 file 또는 유효한 imageUrl이 필요합니다.",
    });
    return;
  }

  try {
    const uploaded = file ?
      await uploadImageBufferToSupabaseStorage(
        file.buffer,
        file.originalname,
        file.mimetype || "application/octet-stream",
        folder,
        publicId
      ) :
      await uploadImageUrlToSupabaseStorage(imageUrl, folder, publicId);

    res.status(200).json({
      ok: true,
      image: uploaded,
      url: uploaded.publicUrl,
      publicId: uploaded.path,
      bucket: getImageBucketName(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Supabase Storage 이미지 업로드 실패:", error);
    res.status(500).json({ok: false, error: message});
  }
});
