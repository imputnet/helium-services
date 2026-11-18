use omaha_protocol::{AppId, Version};
use rand::seq::{IndexedRandom, IteratorRandom};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

const CAPACITY: usize = 2048;

#[derive(Default)]
pub struct Pool {
    apps: Mutex<HashMap<AppId, Version>>,
}

pub fn mixin_count(requested: usize) -> usize {
    if requested == 0 {
        return 0;
    }

    (2.0 * (1.0 + (requested as f64).log2())).ceil() as usize
}

impl Pool {
    pub fn add(&self, appid: AppId, version: Version) {
        let Ok(mut apps) = self.apps.lock() else {
            return;
        };

        if let Some(known) = apps.get_mut(&appid) {
            if version > *known {
                *known = version;
            }
            return;
        }

        if apps.len() >= CAPACITY
            && let Some(evicted) = apps.keys().choose(&mut rand::rng()).cloned()
        {
            apps.remove(&evicted);
        }

        apps.insert(appid, version);
    }

    pub fn pick(&self, exclude: &HashSet<&AppId>, count: usize) -> Vec<(AppId, Version)> {
        let Ok(apps) = self.apps.lock() else {
            return Vec::new();
        };
        let candidates: Vec<(&AppId, &Version)> = apps
            .iter()
            .filter(|(id, _)| !exclude.contains(id))
            .collect();

        candidates
            .choose_multiple(&mut rand::rng(), count)
            .map(|(id, v)| ((*id).clone(), (*v).clone()))
            .collect()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.apps.lock().map_or(0, |apps| apps.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(c: char) -> AppId {
        AppId::new(c.to_string().repeat(32)).unwrap()
    }

    #[test]
    fn mixes_in_more_for_bigger_requests() {
        assert_eq!(mixin_count(0), 0);
        assert_eq!(mixin_count(1), 2);
        assert_eq!(mixin_count(4), 6);
        assert_eq!(mixin_count(100), 16);
    }

    #[test]
    fn keeps_the_newest_version_and_excludes_requested_apps() {
        let pool = Pool::default();
        pool.add(id('a'), "1".parse().unwrap());
        pool.add(id('a'), "3".parse().unwrap());
        pool.add(id('a'), "2".parse().unwrap());
        pool.add(id('b'), "1".parse().unwrap());
        assert_eq!(pool.len(), 2);

        let a = id('a');
        let picked = pool.pick(&HashSet::from([&a]), 5);
        assert_eq!(picked, vec![(id('b'), "1".parse().unwrap())]);

        let all = pool.pick(&HashSet::new(), 5);
        assert!(all.contains(&(id('a'), "3".parse().unwrap())));
    }
}
