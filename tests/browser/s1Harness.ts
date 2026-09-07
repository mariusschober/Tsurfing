// Imported only by the explicit isolated test build. Never a production API.
import React from 'react';
import type { Root } from 'react-dom/client';
import App from '../../App';
import { storageService } from '../../services/storage';
import { synchronizeCloudOnce } from '../../services/cloudSync';
import { reconciliationCandidate } from '../../services/syncProtocol';

export const installS1Harness = (root: Root) => {
  if (import.meta.env.MODE !== 'test') throw new Error('S1 harness requires an isolated test build.');
  Object.assign(window, {
    __s1Storage: storageService,
    __s1Sync: synchronizeCloudOnce,
    __s1Candidate: reconciliationCandidate,
    __s1RenderAccount: (user: string) => root.render(React.createElement(App, {
      key: user, userKey: user, userEmail: user, userRole: 'owner', onLogout: () => root.render(null)
    })),
    __s1Unmount: () => root.render(null)
  });
};
