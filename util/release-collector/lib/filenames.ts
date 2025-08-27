export const isDesiredFile = (platform: string, name: string) => {
    return (platform === 'linux' && name.endsWith('.AppImage')) ||
        (platform === 'macos' && name.endsWith('.dmg')) ||
        (platform === 'windows' && name.endsWith('installer.exe'));
};

export const getArchitecture = (filename: string) => {
    if (filename.includes('aarch64') || filename.includes('arm64')) {
        return 'arm64';
    }

    if (filename.includes('x86_64') || filename.includes('x64')) {
        return 'x86_64';
    }

    throw `could not determine architecture for filename ${filename}`;
};
