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
    // Same-origin paths on purpose: proxy.conf.json forwards /api/* to
    // https://localhost:44388 so the `jwt` cookie stays first-party. Going direct
    // to :44388 is cross-site under schemeful same-site and the cookie is dropped.
    // Production needs the same /api/* rule on whatever serves the built app.
    loginEndpoint: '/api/auth/Login',
    autocompleteEndpoint: '/api/Metadata/autocomplete',
    customerTable: 'bp.customer',
    // Paged entity reader: ?entity=&rows=&page=&parentname=&parentid=&whereparm=&userid=
    entityEndpoint: '/api/Metadata/getentitybyname',
    // Streams an archived file given its server-side fullpath: ?path=c:/temp/x.png
    // Same route the main TALDAR app uses (table-grid openfile()); jwt cookie authorizes it.
    archiveFileEndpoint: '/api/transferdata/getarchivedata',
    archiveEntity: 'gnr.archive',
    archiveRows: 20,
    userId: 10,
  },
  ai: {
    models: [
      { id: 'taldar', label: 'TALDAR Claims LLM', version: 'v2.4' },
      { id: 'claude', label: 'Claude Opus 4.8', version: 'claude-opus-4-8' },
      { id: 'gpt', label: 'GPT-4o', version: 'gpt-4o' },
    ] as AiModel[],
    defaultId: 'taldar',
    chatEndpoint: 'https://localhost:7185/api/gpt5mini/chat', // { userMessage, systemMessage, enableWebSearch } → chat reply
  },
};

export const findOcr = (id: string): OcrEngine =>
  DI_CONFIG.ocr.engines.find((e) => e.id === id) ?? DI_CONFIG.ocr.engines[0];

export const findAi = (id: string): AiModel =>
  DI_CONFIG.ai.models.find((m) => m.id === id) ?? DI_CONFIG.ai.models[0];
