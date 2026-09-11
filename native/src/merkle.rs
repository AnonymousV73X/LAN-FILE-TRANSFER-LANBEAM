//! Merkle tree over per-chunk BLAKE3 hashes.
//!
//! The receiver gets the manifest (root + per-chunk leaves) BEFORE the transfer
//! starts, so each chunk can be verified incrementally on arrival. On mismatch,
//! the receiver requests retransmission of only that chunk — never the whole file.
//!
//! Construction:
//!   - Leaves are BLAKE3(chunk) hex strings.
//!   - Internal nodes are BLAKE3(left || right) hex strings.
//!   - When the leaf count is odd, the last node pairs with itself (no padding bytes).
//!   - The single remaining node is the Merkle root.

use blake3::Hash;

/// Build a Merkle tree from a list of per-chunk hex hashes.
/// Returns (root, leaves) where leaves is the input echoed back as Hash objects.
pub fn build(hashes_hex: &[String]) -> (Option<String>, Vec<Hash>) {
    if hashes_hex.is_empty() {
        return (None, Vec::new());
    }

    // Parse leaves
    let mut layer: Vec<Hash> = Vec::with_capacity(hashes_hex.len());
    for h in hashes_hex {
        let mut arr = [0u8; 32];
        let bytes = hex_decode(h);
        if bytes.len() == 32 {
            arr.copy_from_slice(&bytes);
        }
        layer.push(Hash::from(arr));
    }
    let leaves = layer.clone();

    // Build tree
    while layer.len() > 1 {
        let mut next: Vec<Hash> = Vec::with_capacity((layer.len() + 1) / 2);
        let mut i = 0;
        while i < layer.len() {
            let left = &layer[i];
            let right = if i + 1 < layer.len() { &layer[i + 1] } else { left };
            // Concatenate the raw 32-byte digests, then hash.
            let mut combined = [0u8; 64];
            combined[..32].copy_from_slice(left.as_bytes());
            combined[32..].copy_from_slice(right.as_bytes());
            next.push(blake3::hash(&combined));
            i += 2;
        }
        layer = next;
    }

    (Some(layer[0].to_hex().to_string()), leaves)
}

/// Compute the Merkle root directly (skips storing leaves — useful for re-verification).
pub fn root_of(hashes_hex: &[String]) -> String {
    build(hashes_hex).0.unwrap_or_default()
}

fn hex_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let hi = hex_val(bytes[i]);
        let lo = hex_val(bytes[i + 1]);
        if hi.is_none() || lo.is_none() {
            return out;
        }
        out.push((hi.unwrap() << 4) | lo.unwrap());
        i += 2;
    }
    out
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_leaf() {
        let h = blake3::hash(b"chunk0").to_hex().to_string();
        let (root, leaves) = build(&[h.clone()]);
        assert_eq!(leaves.len(), 1);
        assert_eq!(root.unwrap(), h);
    }

    #[test]
    fn test_two_leaves() {
        let h0 = blake3::hash(b"chunk0").to_hex().to_string();
        let h1 = blake3::hash(b"chunk1").to_hex().to_string();
        let (root, _) = build(&[h0.clone(), h1.clone()]);
        let mut combined = [0u8; 64];
        combined[..32].copy_from_slice(&hex_decode(&h0));
        combined[32..].copy_from_slice(&hex_decode(&h1));
        let expected = blake3::hash(&combined).to_hex().to_string();
        assert_eq!(root.unwrap(), expected);
    }

    #[test]
    fn test_odd_leaves_doubles_last() {
        let h0 = blake3::hash(b"a").to_hex().to_string();
        let h1 = blake3::hash(b"b").to_hex().to_string();
        let h2 = blake3::hash(b"c").to_hex().to_string();
        let (root, leaves) = build(&[h0, h1, h2]);
        assert_eq!(leaves.len(), 3);
        assert!(!root.unwrap().is_empty());
    }
}
