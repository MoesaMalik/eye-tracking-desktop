import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Patients from '../../pages/Patients';
import { usePatientStore } from '../../store/patientStore';

// Mock our Navigation and Store
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Hoist the mock so it runs before imports
vi.mock('../../store/patientStore', () => ({
  usePatientStore: vi.fn(),
}));

describe('Patients Component', () => {
  // Setup the mock store implementation before each test
  const mockAddPatient = vi.fn((data) => ({ id: 'mock-uuid-123', ...data }));
  const mockDeletePatient = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    
    // We simulate usePatientStore by intercepting its selector call
    (usePatientStore as any).mockImplementation((selector: any) => {
      const mockState = {
        addPatient: mockAddPatient,
        deletePatient: mockDeletePatient,
        patients: {}, // Start with empty patient list
        sessionsByPatient: {},
      };
      return selector(mockState);
    });
  });

  it('renders the core title and inputs', () => {
    render(
      <BrowserRouter>
        <Patients />
      </BrowserRouter>
    );

    expect(screen.getByText('Patients')).toBeInTheDocument();
    expect(screen.getByText('New Patient')).toBeInTheDocument();
    
    // Check inputs exist
    expect(screen.getAllByPlaceholderText('AB')[0]).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('2003')[0]).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('Glasses, low light...')[0]).toBeInTheDocument();
  });

  it('submits a new patient and automatically navigates', () => {
    render(
      <BrowserRouter>
        <Patients />
      </BrowserRouter>
    );

    // Enter patient credentials
    fireEvent.change(screen.getAllByPlaceholderText('AB')[0], { target: { value: 'JD' } });
    fireEvent.change(screen.getAllByPlaceholderText('2003')[0], { target: { value: '1990' } });
    fireEvent.change(screen.getAllByPlaceholderText('Glasses, low light...')[0], { target: { value: 'Astigmatism' } });

    // Click submit
    const submitButton = screen.getByText('Add & Start Baseline');
    fireEvent.click(submitButton);

    // Verify store was called correctly
    expect(mockAddPatient).toHaveBeenCalledWith({
      initials: 'JD',
      birthYear: 1990,
      notes: 'Astigmatism'
    });

    // Verify it navigated to the run page with the newly created mock ID
    expect(mockNavigate).toHaveBeenCalledWith('/run?patient=mock-uuid-123');
  });

  it('displays existing patients from the store', () => {
    // Override the mock state for this specific test
    (usePatientStore as any).mockImplementation((selector: any) => {
      const mockState = {
        addPatient: mockAddPatient,
        deletePatient: mockDeletePatient,
        patients: {
          'test-id': {
            id: 'test-id',
            code: 'P-TEST',
            initials: 'XX',
            createdAt: new Date().toISOString()
          }
        },
        sessionsByPatient: {},
      };
      return selector(mockState);
    });

    render(
      <BrowserRouter>
        <Patients />
      </BrowserRouter>
    );

    // Verify the listed patient statistics show up
    expect(screen.getByText('P-TEST')).toBeInTheDocument();
    expect(screen.getByText('(XX)')).toBeInTheDocument();
    
    // Start baseline button should exist for this patient record
    expect(screen.getByText('Start Baseline')).toBeInTheDocument();
  });
});
