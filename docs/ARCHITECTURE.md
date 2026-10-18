# Architecture

Ondine House is three files and two folders of images. There is no build step and no
framework: `index.html` holds the structure and copy, `css/style.css` the design system,
and `js/app.js` everything that moves. This document explains the decisions in `app.js`
and why they were made.

## Layers

Everything except the header and the loader is `position: fixed`, stacked in this order:

| z  | Layer               | Role                                                           |
| -- | ------------------- | -------------------------------------------------------------- |
| 1  | `.hero-standalone`  | Solid stone hero with the name; fades as you scroll            |
| 2  | `.canvas-wrap`      | The video canvas, revealed through a growing `clip-path` circle |
| 3  | `.scrim-*`          | Gradients that darken (or, for the CTA, lighten) the text zone |
| 4  | `#dark-overlay`     | 0.9 opacity behind the stats                                   |
| 5  | `.marquee-wrap`     | Oversized place names sliding across                           |
| 6  | `.scroll-section`   | The copy, one section at a time                                |
| 7  | `.approach`         | The brass Cliff → Pool → Façade → Living gauge                 |
| 20 | `.site-header`      | Logo and navigation                                            |

`#scroll-container` is an empty 1100vh (600vh on phones) block that only exists to be
scrolled. A single ScrollTrigger reads its progress, a number from 0 to 1, and every
layer is a function of that number.

## Scroll position to video frame

The skill this was built from suggests a constant `FRAME_SPEED` of about 2, which finishes
the video at 50% of the scroll. The brief instead asked for each section to sit over the
part of the flight it describes: the pool under "Outdoor living", the curved glass under
"Architecture", the living room under "Interior". A constant speed cannot do both.

So the mapping is a curve through hand-placed keyframes (`VIDEO_KEYS`):

```
scroll  0.00  0.20  0.33  0.47  0.61  0.73  0.84  1.00
video   0.00  0.06  0.25  0.49  0.56  0.74  1.00  1.00
        hero  setting    outdoor  stats  architecture  interior  CTA holds
```

It is interpolated with a monotone cubic (Fritsch–Butland tangents). Monotone matters:
an ordinary cubic spline can overshoot between keyframes and briefly run the video
backwards while you scroll forwards. Smooth matters too: the speed eases at every
keyframe instead of jerking, and the flat tail eases the drone to a stop on the final
frame. Because the frame is a pure function of scroll position, scrolling up replays
exactly the same images in reverse. The test suite checks this pixel for pixel.

## Gliding with 121 frames

The source is 5 seconds at 24 fps, so 121 frames are spread over roughly 9,000 pixels of
scroll, one frame every 70 or so pixels. Drawn one at a time, that steps visibly. The
canvas instead draws frame `⌊f⌋` and then frame `⌊f⌋ + 1` on top at opacity `f − ⌊f⌋`.
Neighbouring frames 1/24 s apart are close enough that the crossfade reads as motion,
not as a dissolve. It costs one extra `drawImage`, and the result is still deterministic.

Drawing happens on the GSAP ticker, once per display frame, and only when the frame
position has changed. Lenis smooths the wheel input upstream, so with a mouse wheel the
video moves about a tenth of a source frame per display frame.

Image smoothing is set to `low` (bilinear) whenever the frame is being enlarged, which is
almost always. On an Intel UHD 620 laptop GPU that brought a draw from about 9 ms to
about 3 ms, with no visible difference when upscaling.

## Padded cover and the matte

The frame is drawn at 86% of "cover" size so the header never crops the top of the shot.
The space around it is filled with the average colour of the frame's outer ring, mixed
55% toward charcoal, and the edges are feathered into that fill with four gradients. The
colours are sampled once per frame at load time, from a 32 × 18 thumbnail.

## Loading

The first ten frames load first, so frame one can paint behind the loader. The rest load
six at a time. Every frame is `decode()`d before it counts, and the loader stays up until
all of them have, so no frame is ever drawn half-decoded and nothing flashes white.
A frame that fails three times is replaced by its nearest neighbour rather than left as
a hole. Phones get a separate set of 90 frames at 960 px (3.6 MB, against 7.9 MB).

## Text that stays readable

Sections are pinned rather than scrolled. Each one is fixed in its side zone and plays
its entrance when progress passes `data-enter`, then plays it in reverse, 1.8 times
faster, after `data-leave`. Text sitting still over moving video is much easier to read
than text that also moves.

Each section names a scrim. The left and right scrims hold at least 0.8 opacity across
the band the text occupies, which keeps light body text above 4.5:1 even over a pure
white frame. The CTA uses a sand scrim with dark text instead, which gives the page its
third colour zone. On phones, text is centred over a single dark scrim. The tests measure
real contrast from screenshots rather than trusting these numbers.

## Motion and reduced motion

Each section uses a different entrance (slide from the left, wipe up, scale, slide from
the right, rotate in, wipe from the left), so no two neighbours share a type or a
direction. Children enter in order (heading, body, note, button) about 0.12 s apart.

With `prefers-reduced-motion: reduce`, Lenis is not started (the browser scrolls
natively), entrances become 0.4 s fades, counters show their final values, and the
marquee stays still. The video still follows the scroll, because that motion is driven
directly by the reader rather than played at them.

## Testing

`test/scroll.test.js` drives an installed Chrome over the DevTools Protocol with no npm
dependencies. Two details are worth knowing if you extend it:

- It always sets `prefers-reduced-motion` explicitly. Headless Chrome otherwise inherits
  the operating system's setting, and on a Windows machine with animation effects
  turned off, every "full motion" run would silently test the reduced-motion path.
- It reads the canvas with `getImageData` six times before sampling. Chrome moves a
  canvas from GPU to CPU memory after repeated readbacks, and the two paths can differ
  by a pixel value or two, which would show up as a false forward/reverse mismatch.

The page exposes a small hook, `window.__ondine`, only when the URL contains `?debug`.
