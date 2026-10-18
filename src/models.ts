import { DEGRADED_SUFFIX } from "./config.ts";
import { encodePath, serviceBlock } from "./iiif.ts";
import { contentInfo } from "./mime.ts";
import { fileStore } from "./store.ts";
import type { CollectionConfig, Env } from "./types.ts";
import type { ImageMeta } from "./images.ts";

/*
 * 3D models of the showcase, stored as "<collection>/model/<id>/model.glb"
 * with "<collection>/model/<id>/meta.json" next to it.
 *
 * - The model is an ordinary protected file: the probe answers 302 with a
 *   signed /files URL once the token is good.
 * - Degraded access (substituteLabel): "<id>-degraded/model.glb" (e.g. a lighter
 *   point cloud) is public, and the probe offers it as `substitute` until then.
 */

export const MODEL_FILE = "model.glb";

const enc = encodeURIComponent;

/** Probe path (relative to the collection) of a model. */
export const modelProbePath = (id: string) => `model/${id}/${MODEL_FILE}`;

export function isModelPath(segs: string[]): boolean {
  return segs.length === 3 && segs[0] === "model" && segs[2] === MODEL_FILE;
}

function isDegradedId(id: string, cfg: CollectionConfig): boolean {
  return !!cfg.substituteLabel && id.endsWith(DEGRADED_SUFFIX) && id.length > DEGRADED_SUFFIX.length;
}

/** The file is the public, degraded copy of a model: /files serves it without a signature. */
export function isPublicModelPath(segs: string[], cfg: CollectionConfig): boolean {
  return isModelPath(segs) && isDegradedId(segs[1], cfg);
}

const fileUrl = (origin: string, c: string, path: string) => `${origin}/files/${enc(c)}/${encodePath(path)}`;

/** The probe's `substitute` for a model: its degraded copy, if the collection has them and it exists. */
export async function modelSubstitute(env: Env, origin: string, c: string, id: string, cfg: CollectionConfig) {
  if (!cfg.substituteLabel || isDegradedId(id, cfg)) return null;
  const path = modelProbePath(`${id}${DEGRADED_SUFFIX}`);
  if (!(await fileStore(env).head(`${c}/${path}`))) return null;
  const info = contentInfo(path);
  return [{ id: fileUrl(origin, c, path), type: info.type, format: info.format, label: cfg.substituteLabel }];
}

/** A Presentation 4 manifest with one Scene holding the model, or null if there is no such model. */
export async function modelManifest(env: Env, origin: string, c: string, cfg: CollectionConfig, id: string) {
  const store = fileStore(env);
  const [metaBody, head] = await Promise.all([
    store.get(`${c}/model/${id}/meta.json`),
    store.head(`${c}/${modelProbePath(id)}`),
  ]);
  if (!metaBody || !head || isDegradedId(id, cfg)) return null;
  const meta = (await new Response(metaBody).json()) as ImageMeta;
  const base = `${origin}/manifest/${enc(c)}/${enc(id)}`;
  const scene = `${base}/scene/1`;
  const path = modelProbePath(id);
  const info = contentInfo(path);
  return {
    "@context": "http://iiif.io/api/presentation/4/context.json",
    id: `${base}.json`,
    type: "Manifest",
    label: meta.label,
    ...(meta.summary ? { summary: meta.summary } : {}),
    ...(meta.requiredStatement ? { requiredStatement: meta.requiredStatement } : {}),
    ...(meta.rights ? { rights: meta.rights } : {}),
    ...(meta.homepage ? { homepage: [{ ...meta.homepage, type: "Text", format: "text/html" }] } : {}),
    items: [
      {
        id: scene,
        type: "Scene",
        label: meta.label,
        spatialScale: { type: "UnitValue", quantityValue: 1.0, unit: "m" },
        items: [
          {
            id: `${base}/page/1`,
            type: "AnnotationPage",
            items: [
              {
                id: `${base}/annotation/1`,
                type: "Annotation",
                motivation: ["painting"],
                target: {
                  type: "SpecificResource",
                  source: [{ id: scene, type: "Scene" }],
                  selector: [{ type: "PointSelector", x: 0, y: 0, z: 0 }],
                },
                body: {
                  // Not readable as is: clients take the signed URL from the probe.
                  id: fileUrl(origin, c, path),
                  type: info.type,
                  format: info.format,
                  service: [serviceBlock(origin, c, path, cfg)],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
