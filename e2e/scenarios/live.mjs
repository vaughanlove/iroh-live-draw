// live: mixed-device realtime convergence (android-tablet + desktop-hidpi
// — the exact dpr split that once broke rendering) with full assertions.
import { launchWorld, appUrl, createProject, shareUrl, drawRect, expect, expectConverged, rendererOf, sleep } from '../dsl.mjs';

export default async function live() {
  const world = await launchWorld();
  try {
    const owner = await world.spawn('desktop-hidpi', await appUrl('?debug=1'), 'owner');
    await sleep(6000);
    const { docId, ticket, key } = await createProject(owner);
    if (!key) throw new Error('[owner] project has no data key');

    const guest = await world.spawn('android-tablet', shareUrl(ticket, key), 'guest');
    await sleep(10000);

    console.log('renderers:', await rendererOf(owner), '|', await rendererOf(guest));

    // Owner draws after join -> guest converges.
    const idA = await drawRect(owner);
    await expect(guest).sceneContains(idA);
    // And back.
    const idB = await drawRect(guest);
    await expect(owner).sceneContains(idB);
    await expectConverged([owner, guest]);

    await expect(owner).noErrors();
    await expect(guest).noErrors();
    console.log('live: PASS');
  } finally {
    await world.close();
  }
}
