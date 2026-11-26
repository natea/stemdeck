# Spec Delta

## Purpose

Holds the named chord patterns ("bricks") and the twelve named moves between them ("joins") that jazz standards are built from, in a form that does not depend on key, and reads a chord chart to say which bricks and joins it is made of.

## ADDED Requirements

### Requirement: Built-in catalogue of bricks
The system SHALL ship a catalogue of bricks. Each entry SHALL have a name, a family (cadence, turnaround, dropback, larger block or other), a formula written as scale degrees and chord types with no key, and its usual length in bars. Each family and each join SHALL have a short description in StemDeck's own words. The catalogue SHALL work with no network connection.

#### Scenario: Look up a cadence
- **WHEN** a user opens the entry for the plain cadence
- **THEN** it shows the formula II minor, V dominant, I major, its usual length and the family "cadence" with that family's description

#### Scenario: Catalogue covers the core families
- **WHEN** the catalogue is listed
- **THEN** it includes at least the plain, minor, long, two-goes, overrun, rainy, starlight and yardbird cadences, the tension ending, the launcher and slow launcher, the plain and suspended turnarounds, the to-IV-and-back turnaround, the dropback and pullback, the rhythm bridge and the Pennies ending

### Requirement: A brick can be spelled in any key
The system SHALL turn any catalogue entry into concrete chords for any of the twelve keys, and SHALL offer the minor form of a brick by swapping its approach and resting chords for their minor equivalents.

#### Scenario: Plain cadence in E flat
- **WHEN** the plain cadence is spelled in E flat
- **THEN** the chords are F minor, B flat dominant, E flat major

#### Scenario: Minor form
- **WHEN** the minor form of the plain cadence is spelled in C
- **THEN** the chords are D half-diminished, G dominant with a raised ninth, C minor with a major seventh

### Requirement: Twelve named joins
The system SHALL name the move from the root where one brick comes to rest to the root where the next brick begins, with one name for each of the twelve possible distances. The name SHALL depend only on that distance, never on the key.

#### Scenario: Every distance has a name
- **WHEN** a brick comes to rest on C and the next brick begins on C, D flat, D, E flat, E, F, F sharp, G, A flat, A, B flat or B
- **THEN** the join is named, in that order, New Horizon, Downwinder, Homer, Cherokee, Woody, Highjump, Bauble, Bootstrap, Stella, Backslider, Half Nelson or Sidewinder

#### Scenario: Same join in another key
- **WHEN** a brick comes to rest on A flat and the next begins on B
- **THEN** the join is a Cherokee, the same as from C to E flat

### Requirement: A chord chart is analysed into bricks and joins
The system SHALL read a chord chart and return an ordered list of bricks that covers the chart, each with its catalogue name, the bars it spans, whether it is in its major or minor form, and the root it comes to rest on, together with the join between each brick that ends at rest and the brick after it. The same chart SHALL always give the same analysis.

#### Scenario: A song built from cadences
- **WHEN** the chart `| C- | % | F- | % | Dø | G7+9 | C-Δ | % | Eb- | Ab7 | DbΔ | % | Dø | G7+9 | C-Δ | % |` is analysed
- **THEN** the result is a two-bar minor hover, a Highjump to a second two-bar minor hover, a Backslider to a minor cadence resting on C, a Cherokee to a major cadence resting on D flat, and a Downwinder to a minor cadence resting on C

#### Scenario: A bridge of four cadences
- **WHEN** a 16-bar bridge of four major cadences is analysed, each starting on the root the one before came to rest on
- **THEN** the result is four cadences, each joined to the next by a New Horizon

#### Scenario: Join across the repeat
- **WHEN** the last brick of a chart comes to rest and the chart repeats
- **THEN** the analysis also names the join from the last brick back to the first

### Requirement: Analysis does not depend on key or chord spelling
The system SHALL give the same bricks and joins for a chart and for the same chart moved to any other key, and for two charts that differ only in how the same chords are spelled.

#### Scenario: Transposed chart
- **WHEN** a chart is analysed in C and again moved up a fourth to F
- **THEN** both analyses list the same bricks and the same joins over the same bars

### Requirement: Hovers and home are identified
The system SHALL label as a hover any chord that lasts more than two bars, and any chord that lasts two bars without being the resting point of the cadence before it. It SHALL work out the home key of each section and mark each brick as resting at home or away from home.

#### Scenario: Four bars on one chord
- **WHEN** a section opens with four bars of G major followed by four bars of G minor
- **THEN** the analysis shows a major hover then a minor hover on the same root, both at home

#### Scenario: The resting point of a cadence is not a hover
- **WHEN** a cadence comes to rest and its last chord lasts two bars
- **THEN** those two bars belong to the cadence and no hover is shown

#### Scenario: Away from home
- **WHEN** a section whose home is C contains a cadence that comes to rest on E flat
- **THEN** that cadence is marked as away from home

### Requirement: The same brick is recognised at different speeds
The system SHALL recognise a brick whether its chords change once a bar, twice a bar or once every two bars, and SHALL report which.

#### Scenario: Cadence in two bars
- **WHEN** a chart has `| D- G7 | CΔ |`
- **THEN** the analysis names a plain cadence at two chords to the bar

### Requirement: Larger blocks are named and can be opened
Where a stretch of chords matches a larger block made of several bricks, the system SHALL name the larger block and SHALL keep the bricks inside it available.

#### Scenario: Rhythm bridge
- **WHEN** an eight-bar bridge moves through four dominant chords round the cycle, two bars each, ending on the dominant of the home key
- **THEN** the analysis names it as a rhythm bridge
- **AND** the user can open it to see the chords it is made of

### Requirement: Unknown stretches are left unnamed
The system SHALL leave bars that match no catalogue entry without a brick name, and SHALL still analyse the bars before and after them.

#### Scenario: A stretch that matches nothing
- **WHEN** a chart has four bars that match no brick between two plain cadences
- **THEN** both cadences are named and the four bars are shown as unnamed

### Requirement: A brick can be heard in any key
The system SHALL play any catalogue entry in any key on request, with a bass note and the chord on each change, without needing a song to be open.

#### Scenario: Hear a turnaround
- **WHEN** a user asks to hear the plain turnaround in A flat
- **THEN** its four chords play in order in A flat at a steady tempo and then stop

### Requirement: The source of the method is credited
The system SHALL credit Conrad Cork's *The New Guide to Harmony with LEGO Bricks* and John Elliott's *Insights in Jazz* as the source of the brick and join names wherever the catalogue is shown, and SHALL NOT contain text, charts or recordings copied from either book.

#### Scenario: Credit in the catalogue
- **WHEN** a user opens the catalogue
- **THEN** both books and their authors are named as the source of the method
