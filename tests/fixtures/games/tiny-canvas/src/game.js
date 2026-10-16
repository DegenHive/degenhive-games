// Tiny Canvas: move the paddle, catch the dots. Each run lasts 4 seconds.
const c = document.getElementById("c");
const g = c.getContext("2d");
let x = 0.5, dots = [], score = 0, run = null, rand = Math.random, t0 = 0;

addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") x -= 0.05; if (e.key === "ArrowRight") x += 0.05; });
addEventListener("pointermove", (e) => { x = e.clientX / innerWidth; });

async function start() {
  run = await DegenHive.runStart();
  rand = DegenHive.random(run.seed);
  score = 0; dots = []; t0 = performance.now();
}

function frame(now) {
  c.width = innerWidth; c.height = innerHeight;
  if (run && rand() < 0.08) dots.push({ x: rand(), y: 0 });
  for (const d of dots) d.y += 0.01;
  score += dots.filter((d) => d.y > 0.9 && Math.abs(d.x - x) < 0.1).length;
  dots = dots.filter((d) => d.y <= 0.9);
  g.fillStyle = "#fc3"; for (const d of dots) g.fillRect(d.x * c.width - 4, d.y * c.height, 8, 8);
  g.fillRect(x * c.width - 40, c.height * 0.92, 80, 8);
  g.fillText(`${score}`, 10, 20);
  if (run && now - t0 > 4000) {
    run = null;
    DegenHive.runEnd({ score }).then(() => setTimeout(start, 500), () => setTimeout(start, 500));
  }
  requestAnimationFrame(frame);
}

DegenHive.ready();
start();
requestAnimationFrame(frame);
