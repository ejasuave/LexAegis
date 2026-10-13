# UI reference notes

Source: three phone screenshots of a wall-mounted monitor playing a neural-network HUD (social-video chrome, orange room lighting and captions are noise, not reference).

- **Layout:** one landscape full-bleed canvas. A single hub sits slightly left of centre, with a lot of empty black around it. Faint HUD microtext sits in the corners and a small centred top label. There are no panels or cards over the field.
- **Nucleus:** a small, very bright white-cyan core. It is surrounded by a dense, radial burst whose halo is brightest at the core and falls off quickly.
- **Filaments:** hundreds of thin (about 1px) curved lines. They radiate outward and branch into thinner twigs. Curves sweep with a slight spiral. Small bright beads and dots sit along some lines and at the tips. Density is highest near the core and thins toward the edges.
- **Glow:** bloom is confined to the core and the beads. Lines stay crisp. Bright states look overexposed (a white-out risk), so keep ours far below that.
- **Colour:** background is near-black with a purple tint. Lines are cool white and blue. Clusters shift to violet/magenta, and one lower cluster is green and yellow. Ours keeps the cobalt, cyan, violet and amber tokens from the blueprint instead.
- **Typography:** tiny monospace, uppercase, widely spaced HUD labels, illegible at distance. One large bold sans callout appears in the last frame. Ours uses readable 13px+ text and no callouts over the canvas.

Video: not viewed (this session cannot play mp4), so motion and timing come from the blueprint only.

## Orb reference (`orb-reference.jpg`, four frames)

- **Idle:** a dim but full network: a dense, wide cluster of linked nodes joined by fine lines, with 20+ long thin tendrils curving outward across the stage, beads along them, and a soft glow at the nucleus. Never a lone dot.
- **Thinking, rising:** tendrils lengthen and brighten; the core turns white-cyan and grows; small glowing particles travel along the tendrils.
- **Peak:** tendrils reach the stage edges. The reference's white-out core is deliberately not copied: ours is a small bounded disc.
- **Ours (reworked to the reference):** a large translucent blue-violet sphere (19% of stage height, 24% thinking) with scanlines and a rim arc turning every 10 s; a 400-node mesh in violet, yellow, red-orange and green lobes that jitters; 24 to 40 tendrils with beads travelling both ways, swaying always, reaching half the stage width (1.6x when thinking). Thinking eases in over about 0.6 s and out over about 1.2 s, pulsing every 1.75 s. With no matter open the orb is the exact stage centre; with one open it is ambient and the reading-zone masks apply. The white-out of the peak panel is replaced by a white-hot rim and bloom.
