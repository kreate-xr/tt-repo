import * as THREE from 'three';
import { scene, camera, renderer, setSceneBackground } from '../scene/sceneSetup.js';
import { loadModels, paddleModel } from '../scene/models.js';

export async function startDesktop({ overlay, loadingScreen, statusEl } = {}) {
  if (overlay) overlay.style.display = 'none';
  setSceneBackground(new THREE.Color(0x1a1a2e));
  await loadModels(loadingScreen, statusEl);

  if (paddleModel) {
    paddleModel.position.set(0.5, 1.0, 0.5);
    scene.add(paddleModel);
  }

  let isDragging = false;
  const prevMouse = { x: 0, y: 0 };
  const spherical = { theta: 0, phi: Math.PI / 4, radius: 3 };

  function updateCamera() {
    camera.position.x = spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
    camera.position.y = spherical.radius * Math.cos(spherical.phi) + 0.8;
    camera.position.z = spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
    camera.lookAt(0, 0.8, 0);
  }

  renderer.domElement.addEventListener('pointerdown', (e) => {
    isDragging = true;
    prevMouse.x = e.clientX;
    prevMouse.y = e.clientY;
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - prevMouse.x;
    const dy = e.clientY - prevMouse.y;
    spherical.theta -= dx * 0.005;
    spherical.phi = Math.max(0.2, Math.min(Math.PI / 2, spherical.phi + dy * 0.005));
    prevMouse.x = e.clientX;
    prevMouse.y = e.clientY;
    updateCamera();
  });

  renderer.domElement.addEventListener('pointerup', () => { isDragging = false; });

  renderer.domElement.addEventListener('wheel', (e) => {
    spherical.radius = Math.max(1, Math.min(6, spherical.radius + e.deltaY * 0.005));
    updateCamera();
  });

  updateCamera();

  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });
}
