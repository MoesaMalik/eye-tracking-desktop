import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Results from '../../pages/Results';
import { usePatientStore } from '../../store/patientStore';

// Mock Router
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams({ patient: 'mock-patient-id' }), vi.fn()],
  };
});

// Mock Store
vi.mock('../../store/patientStore', () => ({
  usePatientStore: vi.fn(),
}));

describe('Results Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    const mockState = {
      patients: {
        'mock-patient-id': {
          id: 'mock-patient-id',
          code: 'P-TEST',
          createdAt: new Date().toISOString()
        }
      },
      sessionsByPatient: {
        'mock-patient-id': [
          { id: 'session-1', startedAt: new Date().toISOString() },
          { id: 'session-2', startedAt: new Date().toISOString() }
        ],
      },
    };

    (usePatientStore as any).mockImplementation((selector: any) => {
      return selector(mockState);
    });

    // Mock IPC for window
    (window as any).nativeApi = { invoke: vi.fn() };
  });

  it('renders the core Results dashboard and session dropdowns', () => {
    render(
      <BrowserRouter>
        <Results />
      </BrowserRouter>
    );

    // Initial Headers
    expect(screen.getByText('Results')).toBeInTheDocument();
    expect(screen.getByText('Patient Selection')).toBeInTheDocument();
    
    // Check patient data
    expect(screen.getAllByText('P-TEST').length).toBeGreaterThan(0);

    // Check comparison box
    expect(screen.getByText('Session Comparison')).toBeInTheDocument();
    expect(screen.getByText('Compare Sessions')).toBeInTheDocument();
  });
});
