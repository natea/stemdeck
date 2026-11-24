# Spec Delta

## Purpose

Lets a player collect phrases they like from real recordings, files each under the brick it was played over, and turns each one into something to practise slowly and then in every key.

## ADDED Requirements

### Requirement: A stretch of a stem can be saved as a phrase
The system SHALL let the user save the current loop range on a chosen stem as a phrase with a name. A saved phrase SHALL record the song, the stem, the start and end, and, where the song has a placed chart, the brick, the chords and the key under it. Phrases SHALL be stored with the song and persist across restarts.

#### Scenario: Save a phrase over a cadence
- **WHEN** a user loops two bars of the saxophone stem over a cadence resting on B flat and saves it as a phrase
- **THEN** the phrase is stored with its song, stem, times, the brick "cadence" and the key B flat

#### Scenario: Song has no chart
- **WHEN** a user saves a phrase on a song with no chart
- **THEN** the phrase is saved without a brick and listed as unfiled

#### Scenario: Song is deleted
- **WHEN** a song is deleted from the library
- **THEN** its phrases are no longer listed

### Requirement: Phrases are collected by brick across the library
The system SHALL show all saved phrases from every song in one collection, grouped by brick family and brick, in major and minor groups, and SHALL let the user filter by brick, stem, song and key, and rename, re-file or delete a phrase.

#### Scenario: Cadence collection
- **WHEN** a user has saved five phrases over cadences in three songs
- **THEN** the cadence group lists all five with their songs

#### Scenario: Re-file a phrase
- **WHEN** the user moves a phrase from "unfiled" to the plain turnaround
- **THEN** it appears under the plain turnaround after a reload

### Requirement: A phrase shows its notes relative to the key
Where the stem has been transcribed, the system SHALL show the phrase's notes with each note's scale degree relative to the key the brick comes to rest in, and SHALL mark the notes that lie outside the scale of the chord sounding under them. Where the stem has not been transcribed, it SHALL say so and offer to transcribe it.

#### Scenario: Transcribed stem
- **WHEN** a phrase over a cadence resting on C contains the notes D, F, A, B, G
- **THEN** they are shown as degrees 2, 4, 6, 7 and 5

#### Scenario: Stem not transcribed
- **WHEN** a phrase is opened on a stem with no transcription
- **THEN** the phrase can still be played and the system offers to transcribe the stem

### Requirement: A phrase can be practised slowly and with or without its player
From a phrase, the system SHALL open its song at the phrase, loop it, apply a practice speed the user chooses, and offer to silence the phrase's own stem so the user can play it over the rest of the band.

#### Scenario: Practise at reduced speed
- **WHEN** the user opens a phrase for practice at 70 percent speed
- **THEN** the song opens with the phrase looped at 70 percent speed

#### Scenario: Take the soloist out
- **WHEN** the user chooses to play the phrase themselves
- **THEN** the phrase's stem is muted for the practice loop and restored when practice ends

### Requirement: A phrase can be taken through all twelve keys
The system SHALL loop a phrase and move it to a new key on each pass until all twelve keys have been played, showing the key and, where notes are available, the notes for that key, and SHALL let the user repeat a key before moving on.

#### Scenario: Through the keys
- **WHEN** the user starts all-keys practice on a phrase and chooses two passes per key
- **THEN** the phrase plays twice in each of the twelve keys with the key named on each pass

#### Scenario: Stay in a hard key
- **WHEN** the user holds the current key
- **THEN** the phrase keeps looping in that key until the user releases it

### Requirement: A collection can be played through as a workout
The system SHALL play a chosen set of phrases one after another, each a set number of times, moving between songs without the user acting, and SHALL show the total length of the set before it starts.

#### Scenario: Workout from the cadence collection
- **WHEN** the user starts a workout with six phrases, three times each
- **THEN** the phrases play in turn three times each, across the songs they come from, and the workout then stops

#### Scenario: A phrase's song is unavailable
- **WHEN** one phrase in a workout belongs to a song whose audio cannot be loaded
- **THEN** that phrase is skipped with a notice and the workout continues
