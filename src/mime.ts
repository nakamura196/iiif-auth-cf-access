export interface ContentInfo {
  type: string;
  format: string;
}

const MAP: Record<string, ContentInfo> = {
  glb: { type: "Model", format: "model/gltf-binary" },
  gltf: { type: "Model", format: "model/gltf+json" },
  stl: { type: "Model", format: "model/stl" },
  obj: { type: "Model", format: "model/obj" },
  mtl: { type: "Text", format: "model/mtl" },
  usdz: { type: "Model", format: "model/vnd.usdz+zip" },
  "3mf": { type: "Model", format: "model/3mf" },
  pdf: { type: "Text", format: "application/pdf" },
  mp3: { type: "Sound", format: "audio/mpeg" },
  mp4: { type: "Video", format: "video/mp4" },
  jpg: { type: "Image", format: "image/jpeg" },
  jpeg: { type: "Image", format: "image/jpeg" },
  png: { type: "Image", format: "image/png" },
  webp: { type: "Image", format: "image/webp" },
};

const DEFAULT: ContentInfo = { type: "Dataset", format: "application/octet-stream" };

export function contentInfo(path: string): ContentInfo {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return DEFAULT;
  return MAP[name.slice(dot + 1).toLowerCase()] ?? DEFAULT;
}
