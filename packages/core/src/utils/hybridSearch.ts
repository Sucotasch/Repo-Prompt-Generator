/**
 * Hybrid Search Utilities
 *
 * Implements BM25 (lexical search) and Reciprocal Rank Fusion (RRF)
 * to combine semantic and keyword-based search results.
 */

export interface RankedChunk<T> {
  item: T;
  score: number;
}

/**
 * Minimal, zero-dependency BM25 implementation for Codebase search.
 * BM25 is a robust lexical search algorithm that handles term frequency
 * and document length normalization.
 */
export class BM25 {
  private documents: string[][] = [];
  private docLengths: number[] = [];
  private averageDocLength: number = 0;
  private termDocumentFrequencies: Map<string, number> = new Map();
  private readonly k1 = 1.2; // Term frequency saturation
  private readonly b = 0.75; // Length normalization

  constructor(corpus: string[]) {
    let totalLength = 0;
    corpus.forEach((doc) => {
      const terms = this.tokenize(doc);
      this.documents.push(terms);
      this.docLengths.push(terms.length);
      totalLength += terms.length;

      const uniqueTerms = new Set(terms);
      uniqueTerms.forEach((term) => {
        this.termDocumentFrequencies.set(
          term,
          (this.termDocumentFrequencies.get(term) || 0) + 1,
        );
      });
    });
    this.averageDocLength = totalLength / Math.max(corpus.length, 1);
  }

  /**
   * Tokenizes text for code analysis.
   * Splits by non-alphanumeric characters, preserving underscores.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter((t) => t.length > 1);
  }

  /**
   * Scores all documents against a query.
   */
  public score(query: string): number[] {
    const queryTerms = this.tokenize(query);
    const N = this.documents.length;
    const scores = new Array(N).fill(0);

    queryTerms.forEach((term) => {
      const df = this.termDocumentFrequencies.get(term) || 0;
      if (df === 0) return;

      // Inverse Document Frequency (IDF)
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      this.documents.forEach((docTerms, docIndex) => {
        const tf = docTerms.filter((t) => t === term).length;
        if (tf === 0) return;

        const docLength = this.docLengths[docIndex];
        const numerator = tf * (this.k1 + 1);
        const denominator =
          tf +
          this.k1 * (1 - this.b + this.b * (docLength / this.averageDocLength));

        scores[docIndex] += idf * (numerator / denominator);
      });
    });

    return scores;
  }
}

/**
 * Reciprocal Rank Fusion (RRF)
 * Fuses the rankings of Vector and Keyword search.
 *
 * @param vectorRanked - List of items ranked by semantic similarity
 * @param lexicalRanked - List of items ranked by BM25 score
 * @param vectorWeight - Weight for semantic results (0 to 1)
 * @param lexicalWeight - Weight for lexical results (0 to 1)
 * @param k - Smoothing constant (default 60)
 */
export function reciprocalRankFusion<T>(
  vectorRanked: T[],
  lexicalRanked: T[],
  vectorWeight: number = 0.5,
  lexicalWeight: number = 0.5,
  k: number = 60,
): RankedChunk<T>[] {
  const rrfScores = new Map<T, number>();

  // Apply RRF math for vector results
  vectorRanked.forEach((item, index) => {
    const rank = index + 1;
    const currentScore = rrfScores.get(item) || 0;
    rrfScores.set(item, currentScore + vectorWeight / (k + rank));
  });

  // Apply RRF math for lexical results
  lexicalRanked.forEach((item, index) => {
    const rank = index + 1;
    const currentScore = rrfScores.get(item) || 0;
    rrfScores.set(item, currentScore + lexicalWeight / (k + rank));
  });

  // Sort by fused score
  return Array.from(rrfScores.entries())
    .map(([item, score]) => ({ item, score }))
    .sort((a, b) => b.score - a.score);
}
