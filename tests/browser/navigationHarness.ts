// Fixture access for the explicit test build; removed from production by Vite.
import React from 'react';
import type { Root } from 'react-dom/client';
import App from '../../App';
import { storageService } from '../../services/storage';

export const installNavigationHarness = (root: Root) => {
  if (import.meta.env.MODE !== 'test') throw new Error('Navigation harness requires an isolated test build.');
  Object.assign(window, {
    __navigationStorage: storageService,
    __navigationRenderAccount: (user: string) => root.render(React.createElement(App, {
      key: user, userKey: user, userEmail: user, userRole: 'owner', onLogout: () => root.render(null)
    })),
  });
};
