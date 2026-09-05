import React, { useState, type FormEvent } from 'react';
import { Logo } from './Logo';
import { unlockTestBuild } from '../services/authService';

export const TestAccessGate: React.FC<{ onUnlock: () => void }> = ({ onUnlock }) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (unlockTestBuild(code.trim())) {
      onUnlock();
      return;
    }
    setError('That test code is not valid.');
  };

  return (
    <main className="min-h-screen bg-[#F7F8FA] flex items-center justify-center p-4 font-sans">
      <section className="w-full max-w-md bg-white border border-[#E4E7EC] rounded-xl p-8 shadow-sm">
        <div className="mb-8"><Logo /></div>
        <h1 className="text-3xl font-semibold text-[#111827]">Tsurfing Test</h1>
        <p className="mt-2 text-[#667085]">This is an isolated local test build. It does not use production authentication or cloud data.</p>
        <form onSubmit={submit} className="mt-8 space-y-3">
          <label className="block text-sm font-medium text-[#344054]" htmlFor="test-code">Test code</label>
          <input
            id="test-code"
            required
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            className="w-full rounded-lg border border-[#D0D5DD] px-3 py-3 tracking-[0.35em] focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button type="submit" className="w-full rounded-lg bg-[#4F46E5] px-4 py-3 font-medium text-white">
            Enter test app
          </button>
        </form>
        {error && <p className="mt-4 text-sm text-red-600" role="alert">{error}</p>}
      </section>
    </main>
  );
};
