type PathOrResource = string;
type Path = string;
type sURL = string;

const _paths: Record<Path, sURL[]> = {};
const _parents: Record<PathOrResource, Path[]> = {};

export const addEntries = (parent: string, entries: Record<string, string[]>) => {
    if (parent in _parents) {
        _parents[parent].forEach((path) => {
            delete _paths[path];
        });
    }

    _parents[parent] = Object.keys(entries);

    for (const [path, urls] of Object.entries(entries)) {
        if (path in _paths) {
            console.warn(`WARN: urls are already defined for ${path}, skipping`);
            continue;
        }

        _paths[path] = [...urls];
    }
};

export const getURLsForPath = (path: string) => {
    return _paths[path];
};
