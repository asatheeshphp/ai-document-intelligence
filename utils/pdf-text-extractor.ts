import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfExtractionResult {
  text: string;
  numPages: number;
}

// Some PDF generation tools (e.g. HTML-to-PDF converters) leave stray markup as literal
// text in the content stream instead of applying the styling and discarding the tag
// (observed: "<b>Grand Total</b>" extracted verbatim from a vendor invoice). Requiring a
// letter immediately after "<" or "</" avoids false positives on plain "<"/">" usage in
// invoice text (e.g. "qty < 10").
function stripStrayMarkup(text: string): string {
  return text.replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi, "");
}

export async function extractPdfText(buffer: Buffer): Promise<PdfExtractionResult> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    useSystemFonts: true,
  });

  const doc = await loadingTask.promise;
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);

      try {
        const content = await page.getTextContent();

        let lastY: number | undefined;
        let pageText = "";

        for (const item of content.items) {
          if (!("str" in item)) continue;
          const currentY = item.transform[5];
          if (lastY !== undefined && currentY !== lastY) {
            pageText += "\n";
          }
          pageText += item.str;
          lastY = currentY;
        }

        pageTexts.push(pageText);
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  return {
    text: stripStrayMarkup(pageTexts.join("\n\n")),
    numPages: doc.numPages,
  };
}
