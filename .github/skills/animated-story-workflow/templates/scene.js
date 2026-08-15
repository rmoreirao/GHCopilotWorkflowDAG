export function mountSceneREPLACE_ID(root, sceneData) {
  if (!(root instanceof Element)) throw new TypeError("A scene root is required");
  root.dataset.sceneId = sceneData.sceneId;
  return () => {
    delete root.dataset.sceneId;
  };
}
