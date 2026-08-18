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
    // Source table per process type; also the object_type that links its gnr.archive rows.
    entityTables: { Claim: 'clm.claimevent', Policy: 'pol.policy', Customer: 'bp.customer', 'Risk Event': 'risk.legalevent' } as Record<string, string>,
    // Paged entity reader: ?entity=&rows=&page=&parentname=&parentid=&whereparm=&userid=
    entityEndpoint: '/api/Metadata/getentitybyname',
    // Streams an archived file given its server-side fullpath: ?path=c:/temp/x.png
    // Same route the main TALDAR app uses (table-grid openfile()); jwt cookie authorizes it.
    archiveFileEndpoint: '/api/transferdata/getarchivedata',
    // Generic row insert: POST ?entity=gnr.archive_OCR with the row as JSON body.
    saveDataEndpoint: '/api/Metadata/savedata',
    // Master+detail insert: POST ?entity=<master> with child rows embedded under a
    // key named for the child entity; server inserts master then links each child.
    insertComplexEndpoint: '/api/Metadata/insertdatacomplex',
    // Multipart file upload → saves the file to disk and inserts a gnr.archive row
    // (fullpath): POST ?entityname=&entityid=&documenttypeid=&note= with form-data files.
    uploadEndpoint: '/api/transferdata/upload',
    // gnr.archive document type. ponytail: only the default is confirmed; fill in the
    // real ids as they're needed. Pass one to uploadFile to override the default.
    documentTypes: { General: 1 } as Record<string, number>,
    defaultDocumentTypeId: 1,
    archiveEntity: 'gnr.v_archive',
    archiveRows: 20,
    userId: 10,
  },
  // Fully local alternative to the cloud OCR + chat pair above: Ollama vision OCR
  // into pgvector, then retrieval-augmented answers from a local model. Served by
  // ingestion-service/src/server.ts; proxy.conf.json forwards /api/local to it.
  local: {
    healthEndpoint: '/api/local/health',
    ingestEndpoint: '/api/local/ingest',
    chatEndpoint: '/api/local/chat',
    topK: 8,
    label: 'Local RAG',
    // Which engine reads the pages locally; sent as ?engine= on every ingest.
    // Embedding and chat stay on Ollama either way. Tesseract is the default:
    // it is an order of magnitude faster and the only one of the two that reads
    // Hebrew reliably. It appears once per language set, because loading the
    // Hebrew model for an English page makes that page worse, not better.
    // The ids must match OCR_ENGINE_IDS in the service.
    engines: [
      { id: 'tesseract-heb', label: 'Tesseract HEB · heb+eng', short: 'Tesseract HEB', modelId: 'tesseract-heb' },
      { id: 'tesseract-eng', label: 'Tesseract ENG · eng', short: 'Tesseract ENG', modelId: 'tesseract-eng' },
      { id: 'ollama', label: 'Ollama Vision', short: 'Ollama', modelId: 'ollama' },
    ] as OcrEngine[],
    defaultEngineId: 'tesseract-heb',
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

/** Same lookup against whichever list the current mode offers. */
export const findEngine = (engines: OcrEngine[], id: string): OcrEngine =>
  engines.find((e) => e.id === id) ?? engines[0];

export const findAi = (id: string): AiModel =>
  DI_CONFIG.ai.models.find((m) => m.id === id) ?? DI_CONFIG.ai.models[0];
