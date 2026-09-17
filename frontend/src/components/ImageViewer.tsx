import { useState, useRef, useEffect } from "react";

export interface ViewerImage {
  id?: string | null;
  imageUrl: string;
  thumbnailUrl?: string | null;
  fileType?: string;
  pdfPageCount?: number | null;
}

const ImageViewer = ({
  imageUrl,
  altText,
  containerClass = 'h-56 sm:h-72 md:h-96',
  fileType,
  pdfPageCount,
  images,
}: {
  imageUrl?: string;
  altText: string;
  containerClass?: string;
  fileType?: string;
  pdfPageCount?: number | null;
  /** All images of the receipt (ordered). When provided, a thumbnail strip
   *  and prev/next controls are shown for receipts with more than one. */
  images?: ViewerImage[];
}) => {
  // Normalize to an ordered list; fall back to the single-image props.
  const list: ViewerImage[] = (images && images.length)
    ? images
    : (imageUrl ? [{ imageUrl, fileType, pdfPageCount }] : []);

  const [activeIndex, setActiveIndex] = useState(0);
  const safeIndex = Math.min(activeIndex, Math.max(0, list.length - 1));
  const active = list[safeIndex];
  const activeUrl = active?.imageUrl || '';
  const activeFileType = active?.fileType ?? fileType;
  const activePdfPages = active?.pdfPageCount ?? pdfPageCount;
  // A PDF image must render in the <iframe>, not as an <img>.
  const isPdf = activeFileType === 'application/pdf'
    || (typeof activePdfPages === 'number' && activePdfPages > 0);

  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Per-image load state keyed by URL. Resetting in a useEffect would race:
  // the <img> starts loading with the new src at commit time, and for
  // instantly-cached images onLoad can fire BEFORE the effect runs — the
  // spinner would then spin forever. Resetting during render (same pass as
  // the new src) guarantees onLoad/onError arrive after the reset.
  const [view, setView] = useState({
    url: activeUrl,
    loading: !!activeUrl,
    error: false,
  });
  if (view.url !== activeUrl) {
    setView({ url: activeUrl, loading: !!activeUrl, error: false });
    setRotation(0);
    setZoom(1);
    setPanX(0);
    setPanY(0);
  }
  // Reset index when the underlying set shrinks/changes identity.
  useEffect(() => {
    if (activeIndex > 0 && activeIndex >= list.length) setActiveIndex(0);
  }, [list.length, activeIndex]);

  const goPrev = () => setActiveIndex(i => (i - 1 + list.length) % list.length);
  const goNext = () => setActiveIndex(i => (i + 1) % list.length);

  const touchContainerRef = useRef<HTMLDivElement>(null);

  // Route all images through the server-side Redis cache proxy.
  // First request: server fetches from Firebase → caches → returns.
  // After prefetch or second view: instant from Redis (no network call).
  // HEIC images are auto-detected and converted server-side.
  //
  // CACHE_BUST: the PDF/image response is cacheable (max-age=86400), so a
  // browser that cached an earlier response with the old
  // `X-Frame-Options: DENY` header kept refusing to frame the PDF even after
  // the server was fixed. Changing the query string changes the cache key and
  // forces a fresh response — bump this when the embed headers change.
  const CACHE_BUST = 'v=2';
  const displayUrl = `/api/images/cached?url=${encodeURIComponent(activeUrl)}&${CACHE_BUST}`;

  const handleRotate = () => {
    setRotation(prev => (prev + 90) % 360);
  };

  const handleZoomIn = () => {
    setZoom(prev => {
      // Finer steps at low zoom, coarser steps at high zoom
      if (prev < 1) return Math.min(prev + 0.25, 1);
      if (prev < 3) return Math.min(prev + 0.5, 3);
      return Math.min(prev + 1, 8);
    });
  };

  const handleZoomOut = () => {
    setZoom(prev => {
      if (prev > 3) return Math.max(prev - 1, 3);
      if (prev > 1) return Math.max(prev - 0.5, 1);
      return Math.max(prev - 0.25, 0.25);
    });
  };

  const handleReset = () => {
    setRotation(0);
    setZoom(1);
    setPanX(0);
    setPanY(0);
  };

  const handleFullscreen = () => {
    setIsFullscreen(true);
  };

  const handleOpenInNewTab = () => {
    // Open the API proxy URL, not the bare /receipt-images path — the latter
    // is not an API route and nginx would serve the SPA index instead.
    window.open(displayUrl, '_blank', 'noopener,noreferrer');
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    setIsDragging(true);
    setDragStart({
      x: e.clientX - panX,
      y: e.clientY - panY
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || zoom <= 1) return;
    
    const newPanX = e.clientX - dragStart.x;
    const newPanY = e.clientY - dragStart.y;
    
    setPanX(newPanX);
    setPanY(newPanY);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (zoom <= 1) return;
    const touch = e.touches[0];
    setIsDragging(true);
    setDragStart({
      x: touch.clientX - panX,
      y: touch.clientY - panY
    });
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging || zoom <= 1) return;
    e.preventDefault();
    
    const touch = e.touches[0];
    const newPanX = touch.clientX - dragStart.x;
    const newPanY = touch.clientY - dragStart.y;
    
    setPanX(newPanX);
    setPanY(newPanY);
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (zoom === 1) {
      setPanX(0);
      setPanY(0);
    }
  }, [zoom]);

  // Non-passive touchmove listener: prevents Android pull-to-refresh while panning
  useEffect(() => {
    const el = touchContainerRef.current;
    if (!el) return;

    const onTouchMove = (e: TouchEvent) => {
      if (zoom > 1) {
        e.preventDefault();
      }
    };

    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, [zoom]);

  const imageTransform = `translate(${panX}px, ${panY}px) rotate(${rotation}deg) scale(${zoom})`;
  const cursorStyle = zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default';
  const zoomPct = Math.round(zoom * 100);

  if (!activeUrl) return null;

  // Thumbnail strip + prev/next for multi-image receipts.
  const strip = list.length > 1 ? (
    <div className="mt-2 flex items-center gap-2">
      <button
        onClick={goPrev}
        className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded border bg-white hover:bg-gray-100 text-gray-600"
        title="Previous image"
      >‹</button>
      <div className="flex gap-1.5 overflow-x-auto flex-1 py-0.5">
        {list.map((im, i) => (
          <button
            key={im.id || i}
            onClick={() => setActiveIndex(i)}
            className={`flex-shrink-0 w-12 h-12 rounded border-2 overflow-hidden bg-gray-100 ${
              i === safeIndex ? 'border-blue-500' : 'border-gray-200 hover:border-gray-300'
            }`}
            title={`Image ${i + 1}`}
          >
            <img
              src={`/api/images/cached?url=${encodeURIComponent(im.thumbnailUrl || im.imageUrl)}&thumb=1&${CACHE_BUST}`}
              alt=""
              className="w-full h-full object-cover"
            />
          </button>
        ))}
      </div>
      <span className="flex-shrink-0 text-xs text-gray-500 tabular-nums">{safeIndex + 1} / {list.length}</span>
      <button
        onClick={goNext}
        className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded border bg-white hover:bg-gray-100 text-gray-600"
        title="Next image"
      >›</button>
    </div>
  ) : null;

  // ── PDF receipts: render inline via iframe (browser-native viewer) ────
  // Zoom/pan don't apply to documents; show open/download actions instead.
  if (isPdf) {
    const pdfDisplayUrl = `/api/images/cached?url=${encodeURIComponent(activeUrl)}&${CACHE_BUST}`;
    const pdfFrame = (
      <div className="border rounded overflow-hidden bg-gray-50">
        <div className={`relative w-full ${containerClass} bg-gray-100`}>
          <iframe
            src={pdfDisplayUrl}
            title={altText}
            className="w-full h-full border-0"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-white border-t">
          <span className="text-xs text-gray-500">
            PDF receipt — rendered by your browser
          </span>
          <a
            href={pdfDisplayUrl}
            download
            className="px-3 py-1.5 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded"
          >
            ⬇ Download PDF
          </a>
        </div>
      </div>
    );

    return (
      <div className="relative">
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap gap-2 bg-white/90 backdrop-blur-sm py-1.5 px-0.5 -mx-0.5 rounded">
          <button onClick={handleOpenInNewTab} className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border" title="Open in New Tab">↗</button>
          <button onClick={handleFullscreen} className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border" title="Fullscreen">⛶</button>
        </div>
        {pdfFrame}
        {strip}
        {isFullscreen && (
          <div className="fixed inset-0 bg-black bg-opacity-90 z-50 flex items-center justify-center" onClick={() => setIsFullscreen(false)}>
            <div className="relative w-full max-w-5xl h-[90vh] p-4" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setIsFullscreen(false)} className="absolute top-2 right-2 text-white text-2xl hover:text-gray-300 z-10 bg-black bg-opacity-50 rounded-full w-10 h-10 flex items-center justify-center">×</button>
              <iframe src={pdfDisplayUrl} title={altText} className="w-full h-full border-0 rounded bg-white" />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Image Controls */}
      <div className="sticky top-0 z-10 mb-3 flex flex-wrap gap-2 bg-white/90 backdrop-blur-sm py-1.5 px-0.5 -mx-0.5 rounded">
        <button onClick={handleRotate} className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border" title="Rotate 90°">🔄</button>
        <button onClick={handleZoomIn} className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border" title="Zoom In">🔍+</button>
        <button onClick={handleZoomOut} className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border" title="Zoom Out">🔍-</button>
        <button onClick={handleReset} className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border" title="Reset">↺</button>
        <button onClick={handleFullscreen} className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border" title="Fullscreen">⛶</button>
        <button onClick={handleOpenInNewTab} className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border" title="Open in New Tab">↗</button>
      </div>

      {/* Image Container */}
      <div className="border rounded overflow-hidden bg-gray-50">
        <div
          ref={touchContainerRef}
          className={`relative w-full ${containerClass} flex items-center justify-center overflow-hidden`}
          style={{ touchAction: zoom > 1 ? 'none' : 'pan-y' }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {view.error ? (
            <div className="text-center p-6">
              <div className="text-4xl mb-3">⚠️</div>
              <div className="text-sm text-red-600 mb-4 font-medium">Failed to load image</div>
              <button onClick={handleOpenInNewTab} className="px-4 py-2 bg-blue-500 text-white rounded text-sm hover:bg-blue-600">Open Original File</button>
            </div>
          ) : (
            <>
              {view.loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent" />
                </div>
              )}
              <img
                src={displayUrl}
                alt={altText}
                onLoad={() => setView((v) => ({ ...v, loading: false }))}
                onError={() => setView((v) => ({ ...v, loading: false, error: true }))}
                className="max-w-full max-h-full object-contain transition-transform duration-200 select-none"
                style={{ transform: imageTransform, cursor: cursorStyle }}
                draggable={false}
              />
            </>
          )}
        </div>
      </div>

      {strip}

      {/* Zoom indicator */}
      {zoom !== 1 && (
        <div className="absolute top-2 right-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-xs">{zoomPct}%</div>
      )}

      {/* Pan hint */}
      {zoom > 1 && (
        <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-xs">Click and drag to pan</div>
      )}

      {/* Fullscreen Modal */}
      {isFullscreen && (
        <div className="fixed inset-0 bg-black bg-opacity-90 z-50 flex items-center justify-center" onClick={() => setIsFullscreen(false)}>
          <div className="relative max-w-full max-h-full p-4">
            <button onClick={() => setIsFullscreen(false)} className="absolute top-2 right-2 text-white text-2xl hover:text-gray-300 z-10 bg-black bg-opacity-50 rounded-full w-10 h-10 flex items-center justify-center">×</button>
            <div
              onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
              onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}
              onClick={(e) => e.stopPropagation()}
            >
              <img src={displayUrl} alt={altText} className="max-w-full max-h-full object-contain select-none"
                style={{ transform: imageTransform, cursor: cursorStyle }} draggable={false} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ImageViewer;