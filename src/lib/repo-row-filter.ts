import type { RepoRow } from "./repo-files-view";

export const REPO_FILE_TAGS = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q8", "F16", "BF16", "mmproj", "mtp", "lora"] as const;

interface VisibleRepoRowIndicesInput {
  rows: readonly Pick<RepoRow, "files">[];
  query: string;
  tags: readonly string[];
}

export function visibleRepoRowIndices({ rows, query, tags }: VisibleRepoRowIndicesInput): Set<number> {
  const keyword = query.trim().toLowerCase();
  const terms = tags.map((tag) => tag.toLowerCase());
  const result = new Set<number>();

  rows.forEach((row, index) => {
    const paths = row.files.map((file) => file.toLowerCase());
    if (terms.length > 0 && !paths.some((file) => terms.some((term) => file.includes(term)))) return;
    if (keyword !== "" && !paths.some((file) => file.includes(keyword))) return;
    result.add(index);
  });
  return result;
}
