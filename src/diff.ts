// Unified diff parsing, ported from coverage_db.py (parse_unified_diff, same_file).

export interface FileChanges {
    /** Old line numbers modified or deleted. */
    changed: Set<number>;
    /** Old line numbers new code is inserted just before. */
    inserted: Set<number>;
}

/** path -> changes, in old line numbers: the side the coverage build was made from. */
export type Changes = Map<string, FileChanges>;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function diffPath(header: string): string | undefined {
    const path = header.split('\t')[0].trim();
    if (path === '/dev/null') {
        return undefined;
    }
    return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

/**
 * Changes from a unified diff (`git diff`). Lines replacing deleted ones are
 * changes, not insertions.
 */
export function parseUnifiedDiff(text: string): Changes {
    const changes: Changes = new Map();
    let oldPath: string | undefined;
    let path: string | undefined;
    let lineNo = 0, oldLeft = 0, newLeft = 0;
    let replacing = false;
    for (const raw of text.split('\n')) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (oldLeft <= 0 && newLeft <= 0) {
            if (line.startsWith('--- ')) {
                oldPath = diffPath(line.slice(4));
                continue;
            }
            if (line.startsWith('+++ ')) {
                path = oldPath ?? diffPath(line.slice(4));
                if (path && !changes.has(path)) {
                    changes.set(path, { changed: new Set(), inserted: new Set() });
                }
                continue;
            }
            const match = HUNK.exec(line);
            if (match && path) {
                const oldCount = match[2] === undefined ? 1 : Number(match[2]);
                lineNo = Number(match[1]) + (oldCount ? 0 : 1);
                oldLeft = oldCount;
                newLeft = match[4] === undefined ? 1 : Number(match[4]);
                replacing = false;
            }
            continue;
        }
        const entry = changes.get(path!)!;
        if (line.startsWith('-')) {
            entry.changed.add(lineNo);
            lineNo += 1;
            oldLeft -= 1;
            replacing = true;
        } else if (line.startsWith('+')) {
            if (!replacing) {
                entry.inserted.add(lineNo);
            }
            newLeft -= 1;
        } else if (line.startsWith(' ')) {
            lineNo += 1;
            oldLeft -= 1;
            newLeft -= 1;
            replacing = false;
        }
    }
    return changes;
}

/** Whether two paths name the same file, one being a suffix of the other. */
export function sameFile(dbPath: string, other: string): boolean {
    return dbPath === other || dbPath.endsWith('/' + other) || other.endsWith('/' + dbPath);
}
