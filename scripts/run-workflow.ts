const storyPrompt = process.argv.slice(2).join(" ").trim();
if (!storyPrompt) {
  console.error('Usage: npm run workflow -- "A robot discovers a garden on Mars"');
  process.exit(1);
}

const response = await fetch("http://localhost:4310/api/runs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    storyPrompt,
    sceneCount: 3,
    visualStyle: "paper-cut",
    maxParallelScenes: 3,
    executor: "copilot"
  })
});

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

console.log(JSON.stringify(await response.json(), null, 2));
