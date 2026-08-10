"use client";

import { useEffect, useRef, useState } from "react";

// Scales a fixed-size diagram canvas down to fit the available width, so the
// whole diagram is always visible without horizontal scrolling. Never upscales
// past 1. Measures its own width and reacts to container/viewport resizes.
export function ScaledCanvas({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, el.clientWidth / width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  return (
    <div ref={ref} style={{ width: "100%", height: height * scale, overflow: "hidden" }}>
      <div
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </div>
  );
}
