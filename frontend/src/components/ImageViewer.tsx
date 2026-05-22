import { useState, useRef, useEffect } from "react";

const ImageViewer = ({
  imageUrl,
  altText,
  containerClass = 'h-56 sm:h-72 md:h-96',
}: {
  imageUrl: string;
  altText: string;
  containerClass?: string;
}) => {
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [loadError, setLoadError] = useState(false);

  const touchContainerRef = useRef<HTMLDivElement>(null);

  if (!imageUrl) return null;

  // Route all images through the server-side Redis cache proxy.
  // First request: server fetches from Firebase → caches → returns.
  // After prefetch or second view: instant from Redis (no network call).
  // HEIC images are auto-detected and converted server-side.
  const displayUrl = `/api/images/cached?url=${encodeURIComponent(imageUrl)}`;

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
    window.open(imageUrl, '_blank', 'noopener,noreferrer');
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
          {loadError ? (
            <div className="text-center p-6">
              <div className="text-4xl mb-3">⚠️</div>
              <div className="text-sm text-red-600 mb-4 font-medium">Failed to load image</div>
              <button onClick={handleOpenInNewTab} className="px-4 py-2 bg-blue-500 text-white rounded text-sm hover:bg-blue-600">Open Original File</button>
            </div>
          ) : (
            <img
              src={displayUrl}
              alt={altText}
              onError={() => setLoadError(true)}
              className="max-w-full max-h-full object-contain transition-transform duration-200 select-none"
              style={{ transform: imageTransform, cursor: cursorStyle }}
              draggable={false}
            />
          )}
        </div>
      </div>

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