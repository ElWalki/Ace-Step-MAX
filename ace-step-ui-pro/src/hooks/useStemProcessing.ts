import { useState, useEffect, useCallback, useRef } from 'react';

export interface StemProcessingState {
  songId: string;
  songTitle: string;
  audioUrl: string;
  backend: string;
  model: string;
  quality: string;
  progress: number; // 0-100
  startedAt: number; // timestamp
  estimatedDuration: number; // seconds
  regionStart?: number; // for sample extraction
  regionEnd?: number;
}

const STORAGE_KEY = 'stem_processing_state';

// Estimated duration by backend quality (in seconds)
const DURATION_ESTIMATES = {
  demucs: { rapida: 60, alta: 120, maxima: 180 },
  uvr: { rapida: 45, alta: 90, maxima: 135 },
  roformer: { rapida: 50, alta: 100, maxima: 150 },
};

function getEstimatedDuration(backend: string, quality: string): number {
  const bk = backend as keyof typeof DURATION_ESTIMATES;
  const qlt = quality as keyof typeof DURATION_ESTIMATES.demucs;
  return DURATION_ESTIMATES[bk]?.[qlt] || 120;
}

export function useStemProcessing() {
  const [processing, setProcessing] = useState<StemProcessingState | null>(null);
  const progressIntervalRef = useRef<number | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const state: StemProcessingState = JSON.parse(stored);
        // Check if it's stale (older than 10 minutes)
        const now = Date.now();
        if (now - state.startedAt < 10 * 60 * 1000) {
          setProcessing(state);
        } else {
          // Clear stale state
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (e) {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, []);

  // Update progress simulation when processing
  useEffect(() => {
    if (!processing) {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      return;
    }

    // Update progress based on elapsed time
    const updateProgress = () => {
      const now = Date.now();
      const elapsed = (now - processing.startedAt) / 1000; // seconds
      const estimatedProgress = Math.min(95, (elapsed / processing.estimatedDuration) * 100);
      
      setProcessing(prev => {
        if (!prev) return null;
        const updated = { ...prev, progress: Math.round(estimatedProgress) };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        return updated;
      });
    };

    // Update every 2 seconds
    progressIntervalRef.current = setInterval(updateProgress, 2000);
    updateProgress(); // immediate update

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    };
  }, [processing?.startedAt, processing?.estimatedDuration]);

  const startProcessing = useCallback((params: {
    songId: string;
    songTitle: string;
    audioUrl: string;
    backend: string;
    model: string;
    quality: string;
    regionStart?: number;
    regionEnd?: number;
  }) => {
    const state: StemProcessingState = {
      ...params,
      progress: 5,
      startedAt: Date.now(),
      estimatedDuration: getEstimatedDuration(params.backend, params.quality),
    };
    setProcessing(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, []);

  const completeProcessing = useCallback(() => {
    setProcessing(null);
    localStorage.removeItem(STORAGE_KEY);
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  }, []);

  const cancelProcessing = useCallback(() => {
    completeProcessing();
  }, [completeProcessing]);

  return {
    processing,
    startProcessing,
    completeProcessing,
    cancelProcessing,
    isProcessing: processing !== null,
  };
}
