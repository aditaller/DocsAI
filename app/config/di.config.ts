/* Document Intelligence — OCR & AI tool configuration.
   Swap engines/models here; the UI reads everything from this file. */

export interface OcrEngine {
  id: string;
  label: string;   // shown in the OCR board header / engine picker
  short: string;   // shown in toasts ("sent to …")
  modelId: string; // surfaced in the raw layout JSON
}

export interface AiModel {
  id: string;
  label: string;
  version: string;
}

export const DI_CONFIG = {
  ocr: {
    engines: [
      // prebuilt-document was removed in DI v4 (2024-11-30); prebuilt-layout absorbed it
      { id: 'azure', label: 'Azure Document Intelligence', short: 'Azure OCR', modelId: 'prebuilt-layout' },
      { id: 'textract', label: 'AWS Textract', short: 'Textract', modelId: 'AnalyzeDocument' },
      { id: 'gcv', label: 'Google Cloud Vision', short: 'Cloud Vision', modelId: 'DOCUMENT_TEXT_DETECTION' },
      { id: 'tesseract', label: 'Tesseract OCR', short: 'Tesseract', modelId: 'tesseract-v5' },
    ] as OcrEngine[],
    defaultId: 'azure',
    endpoint: 'https://localhost:7185/api/TaldarAI/OCRFromBlob', // backend that runs the selected engine; override per deployment
  },
  taldar: {
    // Generic metadata typeahead: ?tablename=&param=&getcol= → [{ id, name }]
    autocompleteEndpoint: 'https://localhost:44388/api/Metadata/autocomplete',
    customerTable: 'bp.customer',
  },
  ai: {
    models: [
      { id: 'taldar', label: 'TALDAR Claims LLM', version: 'v2.4' },
      { id: 'claude', label: 'Claude Opus 4.8', version: 'claude-opus-4-8' },
      { id: 'gpt', label: 'GPT-4o', version: 'gpt-4o' },
    ] as AiModel[],
    defaultId: 'taldar',
  },
};

export const findOcr = (id: string): OcrEngine =>
  DI_CONFIG.ocr.engines.find((e) => e.id === id) ?? DI_CONFIG.ocr.engines[0];

export const findAi = (id: string): AiModel =>
  DI_CONFIG.ai.models.find((m) => m.id === id) ?? DI_CONFIG.ai.models[0];
