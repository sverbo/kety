import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { localHardDeleteCapture } from "./localIndex";
import type { OffSessionNote, OffSessionImage, OffSessionVideo } from "./appTypes";

export function useCaptures(userIdRef: React.MutableRefObject<string | null>) {
  const [notes, setNotes] = useState<OffSessionNote[]>([]);
  const [images, setImages] = useState<OffSessionImage[]>([]);
  const [videos, setVideos] = useState<OffSessionVideo[]>([]);
  const [ocrTextByPath, setOcrTextByPath] = useState<Record<string, string>>({});
  const [fileSizeByPath, setFileSizeByPath] = useState<Record<string, number>>({});

  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);
  const imagesRef = useRef(images);
  useEffect(() => { imagesRef.current = images; }, [images]);
  const videosRef = useRef(videos);
  useEffect(() => { videosRef.current = videos; }, [videos]);

  const deleteCaptureFilesSafe = async (paths: string[]) => {
    const uniq = [...new Set(paths.filter((p) => p.length > 0))];
    if (uniq.length === 0) return;
    await invoke("delete_capture_files", { paths: uniq });
  };

  const removeNoteById = useCallback((id: string) => {
    const note = notesRef.current.find((n) => n.id === id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
    if (userIdRef.current) {
      void localHardDeleteCapture(userIdRef.current, id).then((path) => {
        if (path) void deleteCaptureFilesSafe([path]);
      }).catch(console.error);
    } else if (note?.kind === "document" && note.filePath) {
      void deleteCaptureFilesSafe([note.filePath]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeImageById = useCallback(async (id: string, path: string) => {
    await deleteCaptureFilesSafe([path]);
    setImages((prev) => prev.filter((img) => img.id !== id));
    if (userIdRef.current) void localHardDeleteCapture(userIdRef.current, id).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeVideoById = useCallback(async (id: string, path: string) => {
    await deleteCaptureFilesSafe([path]);
    setVideos((prev) => prev.filter((v) => v.id !== id));
    if (userIdRef.current) void localHardDeleteCapture(userIdRef.current, id).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateOcrText = useCallback((path: string, newText: string) => {
    setOcrTextByPath((prev) => ({ ...prev, [path]: newText }));
  }, []);

  return {
    notes, setNotes, notesRef,
    images, setImages, imagesRef,
    videos, setVideos, videosRef,
    ocrTextByPath, setOcrTextByPath,
    fileSizeByPath, setFileSizeByPath,
    deleteCaptureFilesSafe,
    removeNoteById,
    removeImageById,
    removeVideoById,
    updateOcrText,
  };
}
