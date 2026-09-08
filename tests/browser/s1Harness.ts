// Imported only by the explicit isolated test build. Never a production API.
import React from 'react';
import type { Root } from 'react-dom/client';
import App from '../../App';
import { storageService } from '../../services/storage';
import { synchronizeCloudOnce } from '../../services/cloudSync';
import { admitLocalCounter } from '../../services/causalCounterCoordinator';
import { admitLocalCounterDay } from '../../services/causalCounterDayCoordinator';
import { admitLocalFocus } from '../../services/causalFocusCoordinator';
import { fenceLegacyTracking } from '../../services/causalStorage';
import { fenceLegacyBusinessStores } from '../../services/causalBusinessStorage';
import { bindCausalCapability } from '../../services/causalEnrollment';
import { admitLocalCompletion, prepareCompletionRequest, commitCompletionReceipt } from '../../services/causalCompletionCoordinator';
import { admitLocalTaskCompletion } from '../../services/causalTaskCompletion';
import { reconciliationCandidate } from '../../services/syncProtocol';

export const installS1Harness = (root: Root) => {
  if (import.meta.env.MODE !== 'test') throw new Error('S1 harness requires an isolated test build.');
  Object.assign(window, {
    __s1Storage: storageService,
    __s1Fence: fenceLegacyTracking,
    __s2FenceBusiness: fenceLegacyBusinessStores,
    __s2AdmitCounterDay: admitLocalCounterDay,
    __s2BindCapability: bindCausalCapability,
    __s2AdmitCompletion: admitLocalCompletion,
    __s2AdmitTaskCompletion: admitLocalTaskCompletion,
    __s2PrepareCompletion: prepareCompletionRequest,
    __s2CommitCompletion: commitCompletionReceipt,
    __s1AdmitFocus: admitLocalFocus,
    __s1AdmitCounter: admitLocalCounter,
    __s1Sync: synchronizeCloudOnce,
    __s1Candidate: reconciliationCandidate,
    __s1RenderAccount: (user: string, legacyEmail = user) => root.render(React.createElement(App, {
      key: user, userKey: user, userEmail: legacyEmail, userRole: 'owner', onLogout: () => root.render(null)
    })),
    __s1Unmount: () => root.render(null)
  });
};
