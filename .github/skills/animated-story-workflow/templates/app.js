(() => {
  "use strict";
  const scenes = []; // Replace with generated local scene data.
  let current = 0;

  function render() {
    const scene = scenes[current];
    if (!scene) return;
    document.querySelector("#scene-stage").replaceChildren(scene.element);
    document.querySelector("#scene-status").textContent =
      `Scene ${current + 1} of ${scenes.length}: ${scene.title}`;
  }

  document.querySelector("#previous-scene")?.addEventListener("click", () => {
    current = Math.max(0, current - 1);
    render();
  });
  document.querySelector("#next-scene")?.addEventListener("click", () => {
    current = Math.min(scenes.length - 1, current + 1);
    render();
  });
})();
