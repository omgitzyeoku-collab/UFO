# Cross-corpus diff — war.gov/UFO/ vs. existing public corpora

Generated: 2026-05-09T05:37:55.607Z

## Summary

| Set | Count |
|---|---|
| war.gov/UFO/ Release 01 (canonical) | 115 unique blobs |
| Noise crawl (AARO + FBI Vault + CIA + NASA + NARA + media.defense.gov) | 1408 unique blobs |
| Identical content (same sha256 in both) | 0 |
| In war.gov/UFO/ only | 115 |
| In noise only (i.e. exists publicly elsewhere, not republished by war.gov) | 1408 |

By external domain (noise-only, i.e. material NOT in war.gov/UFO/):
- **www.cia.gov**: 875 unique blobs
- **www.aaro.mil**: 142 unique blobs
- **vault.fbi.gov**: 135 unique blobs
- **www.war.gov**: 85 unique blobs
- **catalog.archives.gov**: 75 unique blobs
- **science.nasa.gov**: 51 unique blobs
- **www.nasa.gov**: 32 unique blobs
- **media.defense.gov**: 13 unique blobs

## Identical content matches (0)

These items in war.gov/UFO/ Release 01 are byte-identical to material that
already exists at one of: www.war.gov, www.aaro.mil, media.defense.gov, vault.fbi.gov, www.cia.gov, science.nasa.gov, catalog.archives.gov, www.nasa.gov.




## Title-similarity matches (0)

These war.gov titles match (Jaccard ≥ 0.4 over title tokens) the filename of a
noise-corpus item but are different sha256s — likely the same document with
different redactions / metadata / scan quality.




## AARO case-resolution PDFs NOT in war.gov/UFO/ (8)

If war.gov/UFO/ is the canonical disclosure mirror, these AARO case
resolutions absent from it are notable.

- https://www.aaro.mil/Portals/136/PDFs/case_resolution_reports/AARO_Al_Taqaddam_Case_Resolution_Final.pdf
- https://www.aaro.mil/Portals/136/PDFs/case_resolution_reports/Mt-Etna-Object.pdf
- https://www.aaro.mil/Portals/136/PDFs/case_resolution_reports/AARO_Puerto_Rico_UAP_Case_Resolution.pdf
- https://www.aaro.mil/Portals/136/PDFs/case_resolution_reports/AARO_GoFast_Case_Resolution_Card_Methodology_Final.pdf
- https://www.aaro.mil/Portals/136/PDFs/case_resolution_reports/Case_Resolution_of_Atmospheric_Wakes_508-02262024.pdf
- https://www.aaro.mil/Portals/136/PDFs/case_resolution_reports/Case_Resolution_of_Eglin_UAP_2_508_.pdf
- https://www.aaro.mil/Portals/136/PDFs/case_resolution_reports/Case_Resolution_of_Southeast_Asia_Triangles_508-02262024.pdf
- https://www.aaro.mil/Portals/136/PDFs/case_resolution_reports/Case_Resolution_of_Western_United_States_Uap_508-02262024.pdf


## FBI Vault UFO parts NOT in war.gov/UFO/ (32)

The CSV description claims the war.gov set is a "complete case file with
several newly declassified pages" of FBI 62-HQ-83894. The Vault has 16 parts
total. Anything missing here is what war.gov chose not to mirror.

- https://vault.fbi.gov/UFO/UFO%20Part%2001/view
- https://vault.fbi.gov/UFO/UFO%20Part%2002/view
- https://vault.fbi.gov/UFO/UFO%20Part%2003/view
- https://vault.fbi.gov/UFO/UFO%20Part%2004/view
- https://vault.fbi.gov/UFO/UFO%20Part%2005/view
- https://vault.fbi.gov/UFO/UFO%20Part%2006/view
- https://vault.fbi.gov/UFO/UFO%20Part%2007/view
- https://vault.fbi.gov/UFO/UFO%20Part%2008/view
- https://vault.fbi.gov/UFO/UFO%20Part%2009/view
- https://vault.fbi.gov/UFO/UFO%20Part%2010/view
- https://vault.fbi.gov/UFO/UFO%20Part%2011/view
- https://vault.fbi.gov/UFO/UFO%20Part%2012/view
- https://vault.fbi.gov/UFO/UFO%20Part%2013/view
- https://vault.fbi.gov/UFO/UFO%20Part%2014/view
- https://vault.fbi.gov/UFO/UFO%20Part%2015/view
- https://vault.fbi.gov/UFO/UFO%20Part%2016%20%28Final%29/view
- https://vault.fbi.gov/UFO/UFO%20Part%2001/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2002/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2003/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2004/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2005/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2006/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2007/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2008/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2009/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2010/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2011/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2012/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2013/at_download/file
- https://vault.fbi.gov/UFO/UFO%20Part%2014/at_download/file

_(+2 more)_

## H10 verdict (preliminary)

Based on automatic byte + title matching:


- 8 AARO case resolutions exist publicly but are NOT in war.gov/UFO/. Possible deliberate omission.
- 32 FBI Vault UFO parts not mirrored. Either intentionally excluded or simply not yet released.

This is automated metadata diff. A meaningful H10 verdict requires
text-level comparison (diff the OCR'd content of the same case across
versions) which needs OCR coverage on both sides.
