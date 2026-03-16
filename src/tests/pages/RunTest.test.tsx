import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RunTest from '../../pages/RunTest';
import { usePatientStore } from '../../store/patientStore';

// Mock Router
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams({ patient: 'mock-patient-id' }), vi.fn()],
    useNavigate: () => vi.fn(),
  };
});

// Mock Store
vi.mock('../../store/patientStore', () => ({
  usePatientStore: vi.fn(),
}));

import * as trackerApi from '../../lib/tracker';

// Mock Tracker Lib
vi.mock('../../lib/tracker', () => ({
  getTrackerStatus: vi.fn(),
  startTracker: vi.fn(),
  stopTracker: vi.fn(),
  openTrackerOutput: vi.fn(),
  startHeadPosition: vi.fn(),
  stopHeadPosition: vi.fn(),
  subscribeHeadPosition: vi.fn(),
}));

describe('RunTest Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        calibration: { label: 'Calibration', slides: ['mock-slide.png'] }
      })
    }));

    vi.stubGlobal('ResizeObserver', vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })));
    
    (trackerApi.getTrackerStatus as any).mockResolvedValue({ status: 'idle', pid: undefined });
    (trackerApi.subscribeHeadPosition as any).mockReturnValue(vi.fn());
    (trackerApi.stopHeadPosition as any).mockResolvedValue({});
    (trackerApi.openTrackerOutput as any).mockResolvedValue({});
    (trackerApi.stopTracker as any).mockResolvedValue({});

    (usePatientStore as any).mockImplementation((selector: any) => {
      const mockState = {
        patients: {
          'mock-patient-id': {
            id: 'mock-patient-id',
            code: 'P-TEST',
            createdAt: new Date().toISOString()
          }
        },
        addSessionSummary: vi.fn(),
        sessionsByPatient: {},
      };
      return selector(mockState);
    });
  });

  it('renders the core tracker interface without crashing', () => {
    // Suppress console.error if protocols.json fetch fails in jsdom
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <BrowserRouter>
        <RunTest />
      </BrowserRouter>
    );

    // Initial State Checks
    expect(screen.getByText('Patient')).toBeInTheDocument();
    expect(screen.getByText('Protocol')).toBeInTheDocument();
    
    // Check patient details render via the mocked params
    expect(screen.getByText('P-TEST')).toBeInTheDocument();

    // Check action buttons render
    expect(screen.getByText('Start Baseline')).toBeInTheDocument();

    errorSpy.mockRestore();
  });
});
