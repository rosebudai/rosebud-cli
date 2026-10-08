const garden = document.querySelector('#garden');
const score = document.querySelector('#score');
const restart = document.querySelector('#restart');
let collected = 0;
let level;
const seeds = Array.from({ length: 9 }, (_, index) => {
  const seed = document.createElement('button');
  seed.type = 'button';
  seed.className = 'seed';
  seed.addEventListener('click', () => {
    if (!level || index !== level.sequence[collected]) return;
    collected += 1;
    render();
    if (collected < level.goal) seeds[level.sequence[collected]].focus();
    else restart.focus();
  });
  garden.append(seed);
  return seed;
});
function render() {
  const won = collected === level.goal;
  score.textContent = won ? '5 / 5 — Your garden is glowing. You win!' : `${collected} / ${level.goal} seeds collected`;
  seeds.forEach((seed, index) => {
    const active = !won && index === level.sequence[collected];
    seed.dataset.active = String(active);
    seed.disabled = !active;
    seed.textContent = active ? '✦' : won ? '✿' : '·';
    seed.setAttribute('aria-label', active ? 'Collect seed' : 'Garden plot');
  });
}
restart.addEventListener('click', () => {
  if (!level) return;
  collected = 0;
  render();
  seeds[level.sequence[collected]].focus();
});
fetch('./levels.json').then(response => {
  if (!response.ok) throw new Error('Level unavailable');
  return response.json();
}).then(data => { level = data; render(); }).catch(() => {
  score.textContent = 'The level could not load. Serve this folder with a local web server, then reload.';
  score.setAttribute('role', 'alert');
});
