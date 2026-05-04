// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// AvatarCropDialog — square-crop editor for the user's profile photo.
// Canvas-based so we don't add a new dependency. Mouse-drag pans the
// image inside the fixed circular crop window; the zoom slider scales
// it. The dialog returns a 512×512 JPEG blob via onSave; the caller
// is responsible for the actual upload.
//
// Used in two flows:
//   1. Upload — caller passes a freshly-picked File. The original blob
//      is also returned so the caller can preserve it server-side.
//   2. Edit existing — caller passes the previously-stored original
//      (fetched from /avatars/:userId/original). User re-positions /
//      re-zooms; the new cropped blob is returned. Original is re-
//      uploaded so the server stays self-consistent.

import { Button, Dialog } from "~/ui";
import { useEffect, useRef, useState } from "react";

const CANVAS_SIZE = 320; // visible square in the dialog
const OUTPUT_SIZE = 512; // final cropped image dimensions
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;

interface AvatarCropDialogProps {
  open: boolean;
  source: Blob | null;
  onOpenChange: (open: boolean) => void;
  onSave: (cropped: Blob, original: Blob) => void | Promise<void>;
  busy?: boolean;
}

export default function AvatarCropDialog({
  open,
  source,
  onOpenChange,
  onSave,
  busy,
}: AvatarCropDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  // Pan in canvas pixels. (0,0) = image centred in canvas.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  }>({ active: false, startX: 0, startY: 0, panX: 0, panY: 0 });

  // (Re)load the source image whenever it or the dialog changes.
  useEffect(() => {
    if (!open || !source) {
      setImageReady(false);
      imgRef.current = null;
      return;
    }
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      // Default zoom: fit the smaller image dimension to the canvas (so
      // the whole crop window is filled) and centre the image.
      const fit = CANVAS_SIZE / Math.min(img.width, img.height);
      setZoom(fit);
      setPan({ x: 0, y: 0 });
      setImageReady(true);
    };
    img.onerror = () => {
      setImageReady(false);
    };
    img.src = url;
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [open, source]);

  // Redraw on any pan/zoom/source change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imageReady) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.fillStyle = "#0a1226";
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    const drawW = img.width * zoom;
    const drawH = img.height * zoom;
    const dx = (CANVAS_SIZE - drawW) / 2 + pan.x;
    const dy = (CANVAS_SIZE - drawH) / 2 + pan.y;
    ctx.drawImage(img, dx, dy, drawW, drawH);

    // Circular crop overlay — soft dim outside the circle.
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.arc(
      CANVAS_SIZE / 2,
      CANVAS_SIZE / 2,
      CANVAS_SIZE / 2 - 1,
      0,
      Math.PI * 2,
      true,
    );
    ctx.fill("evenodd");
    ctx.restore();

    // Crop circle outline.
    ctx.strokeStyle = "rgba(78, 195, 255, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(
      CANVAS_SIZE / 2,
      CANVAS_SIZE / 2,
      CANVAS_SIZE / 2 - 1,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }, [zoom, pan, imageReady]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!imageReady) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d.active) return;
    setPan({
      x: d.panX + (e.clientX - d.startX),
      y: d.panY + (e.clientY - d.startY),
    });
  };
  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current.active = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!imageReady) return;
    const delta = -e.deltaY * 0.0015;
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (1 + delta))));
  };

  const handleSave = async () => {
    const img = imgRef.current;
    if (!img || !source) return;
    // Render at OUTPUT_SIZE preserving the same crop math as the preview.
    const out = document.createElement("canvas");
    out.width = OUTPUT_SIZE;
    out.height = OUTPUT_SIZE;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#0a1226";
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    const scale = OUTPUT_SIZE / CANVAS_SIZE;
    const drawW = img.width * zoom * scale;
    const drawH = img.height * zoom * scale;
    const dx = (OUTPUT_SIZE - drawW) / 2 + pan.x * scale;
    const dy = (OUTPUT_SIZE - drawH) / 2 + pan.y * scale;
    ctx.drawImage(img, dx, dy, drawW, drawH);
    const cropped = await new Promise<Blob | null>((resolve) =>
      out.toBlob((b) => resolve(b), "image/jpeg", 0.92),
    );
    if (!cropped) return;
    await onSave(cropped, source);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o);
      }}
    >
      <Dialog size="base">
        <div className="px-6 pt-6 pb-2">
          <Dialog.Title>Adjust photo</Dialog.Title>
          <Dialog.Description className="mt-1">
            Drag to position. Scroll on the image — or use the slider — to zoom.
            The circle is what other users will see.
          </Dialog.Description>
        </div>

        <div className="flex flex-col items-center gap-4 px-6 py-4">
          <div className="rounded-lg overflow-hidden border border-border bg-card-light">
            <canvas
              ref={canvasRef}
              width={CANVAS_SIZE}
              height={CANVAS_SIZE}
              className="block touch-none cursor-grab active:cursor-grabbing"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onWheel={onWheel}
            />
          </div>
          <div className="flex w-full items-center gap-3">
            <span className="text-xs text-text-muted">Zoom</span>
            <input
              type="range"
              min={MIN_ZOOM * 100}
              max={MAX_ZOOM * 100}
              step={1}
              value={Math.round(zoom * 100)}
              onChange={(e) => setZoom(Number(e.target.value) / 100)}
              className="flex-1 accent-kumo-brand"
              disabled={!imageReady}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="ghost" disabled={busy} type="button">
                Cancel
              </Button>
            )}
          />
          <Button
            variant="primary"
            type="button"
            onClick={handleSave}
            disabled={!imageReady || !!busy}
          >
            {busy ? "Saving…" : "Save photo"}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
