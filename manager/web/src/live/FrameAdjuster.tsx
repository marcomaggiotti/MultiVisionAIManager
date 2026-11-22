import { useMemo } from "react";
import { useObjectUrls } from "../hooks";
import { KeypointEditor } from "../components/KeypointEditor";
import { deleteAdjustment, sameMoment, saveAdjustment } from "./adjustments";
import { FrameResult, Recorded, fmtTime } from "./types";

/** The keypoint editor for one analysed frame of the live studio. Saving stores the
 * adjustment for this moment of the video and updates the frame (and any other recorded
 * frame of the same moment) with the re-evaluated pose. */
export function FrameAdjuster({ frames, index, onFrameChange, onClose }: {
  frames: Recorded[];
  index: number;
  onFrameChange: (index: number, changes: Partial<FrameResult>) => void;
  onClose: () => void;
}) {
  const frame = frames[index];
  const pictures = useMemo(() => [frame.blob as File], [frame.blob]);
  const [imageSrc] = useObjectUrls(pictures);
  const { mediaKey, sourceTime } = frame;
  const dancer = frame.result.dancer;
  if (!dancer || !imageSrc) return null;

  const framesOfThisMoment = () =>
    frames.map((recorded, position) => ({ recorded, position }))
      .filter(({ recorded }) => recorded.mediaKey === mediaKey && sameMoment(recorded.sourceTime, sourceTime));

  const save = async (keypoints: number[][], image: { width: number; height: number }) => {
    if (mediaKey == null || sourceTime == null) return;
    const { adjustment, evaluation } = await saveAdjustment(mediaKey, sourceTime, keypoints, image);
    for (const { position } of framesOfThisMoment()) {
      onFrameChange(position, { dancer: { box: adjustment.box, confidence: 1, keypoints: adjustment.keypoints }, evaluation, adjusted: true });
    }
  };

  const remove = async () => {
    if (mediaKey == null || sourceTime == null) return;
    await deleteAdjustment(mediaKey, sourceTime);
    for (const { recorded, position } of framesOfThisMoment()) {
      onFrameChange(position, { ...(recorded.beforeAdjustment ?? {}), adjusted: false });
    }
  };

  const where = mediaKey ? `${mediaKey.split("|")[0]} at ${sourceTime?.toFixed(2)} s` : "camera";
  return (
    <KeypointEditor
      imageSrc={imageSrc}
      keypoints={dancer.keypoints}
      title={`Adjust keypoints · ${fmtTime(frame.result.t)}`}
      note={`Saved for ${where}: every time this video is analysed, this moment uses your keypoints.`}
      saveDisabledReason={mediaKey == null ? "Camera frames cannot be saved: adjustments belong to a video file or to pictures." : null}
      onSave={save}
      onRemove={frame.result.adjusted && mediaKey != null ? remove : undefined}
      onClose={onClose}
    />
  );
}
