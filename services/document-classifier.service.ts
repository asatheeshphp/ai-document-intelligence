import { OllamaService } from "@/services/ollama.service";
import type { DocumentClassification } from "@/schemas/document-classification.schema";

// Confirmed live: a small local model (qwen2.5:1.5b) can write reasoning that
// explicitly concludes "this is an invoice" and then still answer "OTHER" on the same
// call -- a self-consistency failure, not a prompt-clarity problem. Observed the correct
// answer agreeing with the model's own reasoning roughly 1 in 3 calls on a genuinely
// borderline document (a recurring utility bill). A single classification call isn't
// reliable enough on its own; voting across a few independent attempts is.
const CLASSIFICATION_VOTES = 3;

function majorityVote(votes: DocumentClassification[]): DocumentClassification {
  const counts = new Map<string, number>();
  for (const vote of votes) {
    counts.set(vote.documentType, (counts.get(vote.documentType) ?? 0) + 1);
  }

  // Ties broken by first occurrence -- with an odd number of votes across a small
  // label set, a true tie only happens if every vote disagreed, which is rare enough
  // not to warrant a more elaborate tie-break.
  let winningType = votes[0].documentType;
  let winningCount = 0;
  for (const [type, count] of counts) {
    if (count > winningCount) {
      winningCount = count;
      winningType = type as DocumentClassification["documentType"];
    }
  }

  const winningVotes = votes.filter((vote) => vote.documentType === winningType);
  const averageConfidence = winningVotes.reduce((sum, vote) => sum + vote.confidence, 0) / winningVotes.length;

  return { documentType: winningType, confidence: averageConfidence };
}

export class DocumentClassifierService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  /**
   * Classifies a document by asking the model CLASSIFICATION_VOTES times and taking a
   * majority vote across the attempts, rather than trusting a single call -- see the
   * constant's comment for why a single shot isn't reliable enough on borderline
   * content. A failed individual attempt counts as an "OTHER, 0 confidence" vote rather
   * than aborting the whole classification.
   */
  async classify(text: string): Promise<DocumentClassification> {
    const votes: DocumentClassification[] = [];

    for (let i = 0; i < CLASSIFICATION_VOTES; i += 1) {
      const outcome = await this.ollamaService.classifyDocument(text);
      if (!outcome.success || !outcome.data) {
        console.warn("Document classification attempt failed, counting as OTHER:", outcome.error);
        votes.push({ documentType: "OTHER", confidence: 0 });
      } else {
        votes.push(outcome.data);
      }
    }

    return majorityVote(votes);
  }
}
