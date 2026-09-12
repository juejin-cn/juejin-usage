import { createRouter } from '@tanstack/react-router';
import { createHashHistory } from '@tanstack/history';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  // Packaged Electron opens the renderer through file://. Hash history keeps
  // the local index.html path out of TanStack Router's route matching.
  history: createHashHistory(),
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
