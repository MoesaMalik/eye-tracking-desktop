import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AnalyzeVideo from '../../pages/AnalyzeVideo';

// Mock Recharts to avoid complicated SVG rendering in jsdom
vi.mock('recharts', () => {
  const Dummy = (props: any) => <div data-testid="mock-recharts">{props.children}</div>;
  return {
    ResponsiveContainer: Dummy,
    LineChart: Dummy,
    Line: Dummy,
    XAxis: Dummy,
    YAxis: Dummy,
    CartesianGrid: Dummy,
    Tooltip: Dummy,
    ReferenceLine: Dummy,
    ReferenceArea: Dummy,
  };
});

import * as recordingAnalysis from '../../lib/recording-analysis';

// Mock Backend Analysis API
vi.mock('../../lib/recording-analysis', () => ({
  listSessions: vi.fn(),
  readSessionTracking: vi.fn(),
  readSessionTransitions: vi.fn(),
  detectStimuliAndFit: vi.fn(),
  fitRecordingData: vi.fn(),
  saveRecordingResults: vi.fn(),
  getSessionVideoPath: vi.fn(),
  readRawTrackingData: vi.fn(),
}));

describe('AnalyzeVideo Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (recordingAnalysis.listSessions as any).mockResolvedValue([
      { sessionId: 'test-recording-124', date: new Date().toISOString() }
    ]);
    (recordingAnalysis.getSessionVideoPath as any).mockResolvedValue({ ok: false });
    (recordingAnalysis.readRawTrackingData as any).mockResolvedValue({ ok: false });
  });

  it('renders the core Analyze tool interface', async () => {
    render(
      <BrowserRouter>
        <AnalyzeVideo />
      </BrowserRouter>
    );

    // Wait for the async listSessions API to render our default UI
    expect(await screen.findByText('Analyze Recording Data')).toBeInTheDocument();
    
    // Verify tools menu renders
    expect(screen.getByText('Load Data')).toBeInTheDocument();
    expect(screen.getByText('Fit Events')).toBeInTheDocument();
    expect(screen.getByText('Save to CSV')).toBeInTheDocument();

    // Verify filter parameters exist
    expect(screen.getByText('Signal Type')).toBeInTheDocument();
    expect(screen.getByText('Filter Level')).toBeInTheDocument();
  });
});
