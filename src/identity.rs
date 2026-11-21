use rand::seq::SliceRandom;
use rand::Rng;

const FIRST: &[&str] = &[
    "james", "oliver", "liam", "noah", "ethan", "mason", "lucas", "henry", "jack", "leo",
    "mia", "ava", "sofia", "emma", "olivia", "amelia", "isla", "chloe", "grace", "nora",
    "adam", "eric", "mark", "daniel", "victor", "paul", "kevin", "brian", "scott", "craig",
    "nathan", "aaron", "jason", "justin", "ryan", "tyler", "dylan", "caleb", "owen", "miles",
];

const LAST: &[&str] = &[
    "smith", "johnson", "williams", "brown", "jones", "garcia", "miller", "davis", "wilson",
    "anderson", "thomas", "taylor", "moore", "jackson", "martin", "lee", "perez", "thompson",
    "white", "harris", "clark", "lewis", "walker", "hall", "young", "king", "wright", "scott",
    "green", "baker", "adams", "nelson", "hill", "campbell", "mitchell", "roberts", "carter",
    "phillips", "evans", "turner",
];

#[derive(Debug, Clone)]
pub struct Identity {
    pub first_name: String,
    pub last_name: String,
    pub local_part: String,
    pub email: String,
    pub password: String,
}

impl Identity {
    pub fn vars(&self) -> Vec<(&'static str, String)> {
        vec![
            ("first_name", self.first_name.clone()),
            ("last_name", self.last_name.clone()),
            ("local_part", self.local_part.clone()),
            ("email", self.email.clone()),
            ("password", self.password.clone()),
        ]
    }
}

pub fn generate(domain: &str) -> Identity {
    let mut rng = rand::thread_rng();
    let first = pick(FIRST, &mut rng).to_string();
    let last = pick(LAST, &mut rng).to_string();
    let digits = rng.gen_range(10u32..9999u32);

    let local_part = match rng.gen_range(0..4) {
        0 => format!("{first}{last}{digits}"),
        1 => format!("{first}.{last}{digits}"),
        2 => format!("{first}{}{digits}", &last[..1]),
        _ => format!("{first}{}", rng.gen_range(100_000u32..999_999u32)),
    };

    Identity {
        first_name: title_case(&first),
        last_name: title_case(&last),
        email: format!("{local_part}@{domain}"),
        local_part,
        password: generate_password(&mut rng),
    }
}

pub fn generate_password(rng: &mut impl Rng) -> String {
    const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
    const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
    const DIGITS: &[u8] = b"23456789";
    const SYMBOLS: &[u8] = b"!@#$%^&*-_=+";

    let mut out = Vec::with_capacity(16);
    out.push(*UPPER.choose(rng).unwrap());
    out.push(*LOWER.choose(rng).unwrap());
    out.push(*DIGITS.choose(rng).unwrap());
    out.push(*SYMBOLS.choose(rng).unwrap());

    let alphabet: [&[u8]; 4] = [UPPER, LOWER, DIGITS, SYMBOLS];
    while out.len() < 16 {
        let set = alphabet[..].choose(rng).copied().unwrap_or(LOWER);
        if let Some(byte) = set.choose(rng) {
            out.push(*byte);
        }
    }
    out.shuffle(rng);
    String::from_utf8(out).expect("ascii alphabet")
}

fn pick<'a>(pool: &'a [&'a str], rng: &mut impl Rng) -> &'a str {
    pool.choose(rng).copied().unwrap_or("alex")
}

fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
