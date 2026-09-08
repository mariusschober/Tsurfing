import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import './index.css';
import AppWrapper from './AppWrapper';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <AppWrapper />
);

if (import.meta.env.MODE === 'test') {
  void import('./tests/browser/s1Harness').then(({ installS1Harness }) => installS1Harness(root));
  void import('./tests/browser/navigationHarness').then(({ installNavigationHarness }) => installNavigationHarness(root));
}
