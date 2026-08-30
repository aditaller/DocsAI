/* Document Intelligence — mock data & content (ported from the standalone bundle) */

import { AnalysisResponse, Doc, FileType, Preview, PromptTemplate, RawOcr } from '../models/models';

export const TEMPLATES: Record<string, PromptTemplate> = {
  custom: { label: 'Custom…', text: '' },
  summary: {
    label: 'Summary',
    system:
      'You are a claims analyst. Input is raw OCR text of one or more claim documents, each preceded by "# <filename>". OCR errors are expected — read through them, never quote them as facts. Answer only from the text; if something is not stated, say "not stated in the documents". Attribute every fact to its filename. Plain prose, no headings or bullets unless asked.format your response as compact HTML, with <b> for emphasis and <span class="hl"> for highlighting. Do not include any external links or references. Do not include any disclaimers or caveats.',
    text: 'Summarize each document in 3–4 sentences, capturing the core facts of the claim, the parties involved, and the current status.',
  },
  dates: {
    label: 'Key Dates Extraction',
    system:
      'You are a claims analyst extracting temporal data from raw OCR of claim documents, each preceded by "# <filename>". Return only dates that appear in the text — never infer, complete, or correct a date. Normalize to YYYY-MM-DD; if a date is partial or ambiguous, output it verbatim and mark it ambiguous. Every entry carries its source filename and the label it appeared under. Chronological order. No commentary.format your response as compact HTML, with <b> for emphasis and <span class="hl"> for highlighting. Do not include any external links or references. Do not include any disclaimers or caveats.',
    text: 'Extract all dates referenced across the documents — loss date, report date, inspection dates, and any deadlines. Return them in chronological order with the source document for each.',
  },
  risk: {
    label: 'Risk Flags',
    system:
      'You are a claims fraud and completeness reviewer. Input is raw OCR of claim documents, each preceded by "# <filename>". Flag only discrepancies supported by the text — conflicting figures, conflicting dates, missing required documents, timeline gaps. Distinguish an OCR artifact from a real inconsistency and do not flag the former. Rank flags high/medium/low by severity, and for each cite the exact conflicting values and their source filenames. Absence of evidence is not evidence of fraud; say so when the documents are simply incomplete. format your response  as compact   HTML, with <b> for emphasis and <span class="hl"> for highlighting. Do not include any external links or references. color each severity left border.',
    text: 'Identify any inconsistencies, missing documentation, late reporting, or indicators of potential fraud across the documents. Rank each flag by severity.',
  },
};

export const DEFAULT_PROMPT =
  'Extract all claim dates, amounts, and party names. Flag any inconsistencies between the FNOL and the adjuster statement.';

export const SEED_RESPONSE: AnalysisResponse = {
  id: 'r1',
  docNames: ['FNOL_Report_08817.pdf'],
  timestamp: 'Jun 09, 2026 · 14:32',
  model: 'taldar-claims-llm · v2.4',
  saved: false,
  summary:
    'The First Notice of Loss documents a <span class="hl">single-vehicle collision</span> reported by policyholder <span class="hl">Daniel R. Okonkwo</span> on a 2022 Honda CR-V. Loss occurred on <span class="hl">May 28, 2026</span> and was reported <span class="hl">5 days later</span>. Estimated damage is <span class="hl">$14,250</span>, with the vehicle deemed driveable. No injuries or third parties were recorded.',
  fields: [
    { k: 'Policyholder', v: 'Daniel R. Okonkwo' },
    { k: 'Policy No.', v: 'POL-2024-44910' },
    { k: 'Date of Loss', v: '2026-05-28' },
    { k: 'Date Reported', v: '2026-06-02' },
    { k: 'Loss Amount', v: '$14,250.00', amount: true },
    { k: 'Deductible', v: '$1,000.00', amount: true },
    { k: 'Net Exposure', v: '$13,250.00', amount: true },
    { k: 'Vehicle', v: '2022 Honda CR-V' },
  ],
  flags: [
    { sev: 'warn', title: 'Late reporting', body: 'Loss reported 5 days after the incident — exceeds the 72-hour policy notification window.' },
    { sev: 'info', title: 'Pending corroboration', body: 'Adjuster statement is still in OCR. Cross-document amount validation will run once processing completes.' },
  ],
};

export const RAW_OCR: Record<string, RawOcr> = {
  j1: {
    pages: 4,
    avgConf: 98.7,
    lowConf: 2,
    lines: [
      '<span class="field">CLAIM TYPE:</span>  Auto — Collision (Comprehensive)',
      '<span class="field">POLICY NO:</span>   POL-2024-44910',
      '<span class="field">INSURED:</span>     Daniel R. Okonkwo',
      '<span class="field">DATE OF LOSS:</span> 2026-05-28   14:10 approx.',
      '<span class="field">REPORTED:</span>    2026-06-02   09:41',
      '',
      'NARRATIVE OF LOSS',
      'Insured states vehicle left the roadway on Route 9 near',
      'exit <span class="lo">17B</span> during heavy rain and struck a guardrail.',
      'Front-left quarter panel and bumper sustained damage.',
      'Vehicle remained <span class="lo">driveable</span>. No other vehicles involved.',
      '',
      '<span class="field">EST. DAMAGE:</span> $14,250.00',
      '<span class="field">DEDUCTIBLE:</span>  $1,000.00',
      '<span class="field">INJURIES:</span>    None reported',
      '<span class="field">WITNESSES:</span>   None',
    ],
  },
};

export const PREVIEWS: Record<string, Preview> = {
  d1: {
    kind: 'form',
    org: 'TALDAR Claims Intake',
    title: 'First Notice of Loss',
    ref: 'FNOL-08817 · Policy POL-2024-44910',
    meta: [['Claim Type', 'Auto — Collision'], ['Date of Loss', '2026-05-28'], ['Reported', '2026-06-02 09:41'], ['Adjuster', 'Unassigned']],
    fields: [
      ['Policyholder', 'Daniel R. Okonkwo'],
      ['Contact', '+1 (415) 555-0192'],
      ['Vehicle', '2022 Honda CR-V — VIN 5J6RW2H8XNL0••••'],
      ['Location of Loss', 'Route 9 near Exit 17B'],
    ],
    narrativeTitle: 'Narrative of Loss',
    narrative:
      'Insured states the vehicle left the roadway on Route 9 near Exit 17B during heavy rain and struck a guardrail. Front-left quarter panel and bumper sustained damage. Vehicle remained driveable. No other vehicles involved, no injuries, no witnesses.',
    totals: [['Estimated Damage', '$14,250.00'], ['Deductible', '$1,000.00'], ['Net Exposure', '$13,250.00']],
  },
  d2: {
    kind: 'doc',
    org: 'TALDAR Field Operations',
    title: 'Field Adjuster Statement',
    ref: 'ADJ-08817 · Inspected 2026-06-04',
    meta: [['Adjuster', 'M. Reyes (Lic. #FA-22841)'], ['Inspection', 'On-site'], ['Vehicle Status', 'Driveable']],
    paragraphs: [
      "On-site inspection of the 2022 Honda CR-V confirms impact damage consistent with the policyholder's account. Primary damage is concentrated on the front-left quarter panel, bumper assembly, and headlamp housing.",
      'Disassembly revealed additional damage to the inner fender liner and the lower control arm bracket that was not visible at first notice. These hidden items raise the repair estimate above the original FNOL figure.',
      'Revised repair estimate: $16,800.00. Recommend reconciliation against the FNOL estimate of $14,250.00 prior to settlement authorization. No indicators of pre-existing damage or misrepresentation were observed.',
    ],
    totals: [['FNOL Estimate', '$14,250.00'], ['Revised Estimate', '$16,800.00'], ['Variance', '+$2,550.00']],
  },
  d3: {
    kind: 'image',
    org: 'Evidence — Photographic',
    title: 'Vehicle Damage Set',
    ref: '12 images · captured 2026-06-05',
    caption: 'Front-left quarter panel and bumper — primary impact zone',
    shots: ['Front-left quarter panel', 'Bumper assembly', 'Headlamp housing', 'Wide — driver side'],
  },
  d4: {
    kind: 'form',
    org: 'State Highway Patrol',
    title: 'Police Report',
    ref: 'Report #4471 · 2026-05-28',
    meta: [['Officer', 'Tpr. J. Hassan #1184'], ['Incident', 'Single-vehicle, weather'], ['Citation', 'None issued']],
    fields: [
      ['Driver', 'Daniel R. Okonkwo'],
      ['Conditions', 'Heavy rain, wet roadway'],
      ['Road', 'Route 9 SB, near Exit 17B'],
    ],
    narrativeTitle: 'Officer Narrative',
    narrative:
      'Vehicle hydroplaned and contacted the guardrail. Driver alert, no injuries reported on scene. Vehicle driven from scene. No other parties involved. No citation issued.',
  },
  d5: {
    kind: 'table',
    org: 'AutoBody Collision Center',
    title: 'Repair Estimate',
    ref: 'Estimate EB-7741 · 2026-06-06',
    lines: [
      ['Front bumper cover — R&R', '$640.00'],
      ['LF quarter panel — repair & refinish', '$3,180.00'],
      ['Headlamp assembly LH', '$1,420.00'],
      ['Inner fender liner', '$310.00'],
      ['Lower control arm bracket', '$1,950.00'],
      ['Paint & materials', '$2,100.00'],
      ['Labor (42.5 hrs)', '$6,800.00'],
    ],
    totals: [['Subtotal', '$16,400.00'], ['Tax', '$400.00'], ['Total', '$16,800.00']],
  },
  d6: {
    kind: 'image',
    org: 'Evidence — Photographic',
    title: 'Scene Overview',
    ref: '1 image · captured 2026-05-28',
    caption: 'Wide view of the incident location — Route 9 near Exit 17B',
    shots: ['Roadway & guardrail', 'Skid path', 'Vehicle final rest'],
  },
};

// ----- helpers -----
export const uid = (): string => 'x' + Math.random().toString(36).slice(2, 9);

export const nowClock = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const randomConfidence = (): number => Math.round((94 + Math.random() * 5.6) * 10) / 10;

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtDate = (d: Date): string =>
  `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`;

export const fileType = (name: string): FileType => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'rtf', 'txt', 'odt', 'pages'].includes(ext)) return 'word';
  return 'image';
};
