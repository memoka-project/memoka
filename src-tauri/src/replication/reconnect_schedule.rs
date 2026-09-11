use std::{collections::BTreeMap, time::Duration};

use tokio::time::Instant;

#[derive(Default)]
pub(super) struct ReconnectSchedule {
    retries: BTreeMap<String, (Instant, u32)>,
}

impl ReconnectSchedule {
    pub fn waiting(&self, key: &str, now: Instant) -> bool {
        self.retries.get(key).is_some_and(|(at, _)| *at > now)
    }

    pub fn connected(&mut self, key: &str) {
        self.retries.remove(key);
    }

    pub fn ended(&mut self, key: String, now: Instant, refresh: bool) -> Duration {
        // A scheduled connection refresh is not a failed connection attempt.
        let attempts = if refresh {
            0
        } else {
            self.retries
                .get(&key)
                .map_or(0, |(_, attempts)| *attempts)
                .saturating_add(1)
                .min(6)
        };
        let delay = Duration::from_secs(if refresh {
            1
        } else {
            (1_u64 << attempts).min(30)
        });
        self.retries.insert(key, (now + delay, attempts));
        delay
    }

    pub fn clear(&mut self) {
        self.retries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_counts_only_consecutive_failures_and_resets_after_connection() {
        let mut schedule = ReconnectSchedule::default();
        let mut now = Instant::now();
        for seconds in [2, 4, 8, 16, 30, 30] {
            let delay = schedule.ended("peer".into(), now, false);
            assert_eq!(delay, Duration::from_secs(seconds));
            assert!(schedule.waiting("peer", now));
            now += delay;
            assert!(!schedule.waiting("peer", now));
        }
        schedule.connected("peer");
        assert_eq!(
            schedule.ended("peer".into(), now, false),
            Duration::from_secs(2)
        );
        schedule.clear();
        assert!(!schedule.waiting("peer", now));
    }

    #[test]
    fn periodic_refreshes_never_accumulate_failure_backoff() {
        let mut schedule = ReconnectSchedule::default();
        let now = Instant::now();
        for _ in 0..10 {
            assert_eq!(
                schedule.ended("peer".into(), now, true),
                Duration::from_secs(1)
            );
        }
        assert_eq!(
            schedule.ended("peer".into(), now, false),
            Duration::from_secs(2)
        );
    }
}
