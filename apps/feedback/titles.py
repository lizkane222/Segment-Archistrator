"""
A problem title, derived from the problem description.

The request: *"problem title should be the first five words of the description minus any words that are
articles (the, a, an, it...) or prepositions (in, on, under...)"*.

Read carefully, "the first five words minus the skipped ones" is ambiguous between two readings, and
they give different answers:

  a) Take five words, then drop the articles and prepositions among them.
  b) Walk the description, skipping articles and prepositions, until five words have been *kept*.

This implements (b), and the reason is what the title is for. "the event in the debugger is not shown"
under reading (a) gives "event debugger" -- two words from a nine-word sentence, because four of the
first five were skipped. Under (b) it gives "event debugger is not shown", which is a title someone
scanning a list of feedback can actually recognise. The purpose of dropping the small words is to spend
the five slots on words that carry meaning, and (a) spends them and then throws them away.
"""

import re

# Articles, and the pronouns the request's "it" points at -- a title starting "it doesn't work" says
# nothing, and neither do "this", "that" or "there".
_ARTICLES = {
    "a",
    "an",
    "the",
    "it",
    "its",
    "this",
    "that",
    "these",
    "those",
    "there",
    "their",
    "they",
    "them",
}

# English prepositions, the common ones. Not exhaustive on purpose: a long tail like "notwithstanding"
# never appears in a bug report, and every entry is a word that can no longer appear in a title.
_PREPOSITIONS = {
    "about",
    "above",
    "across",
    "after",
    "against",
    "along",
    "among",
    "around",
    "as",
    "at",
    "before",
    "behind",
    "below",
    "beneath",
    "beside",
    "between",
    "beyond",
    "by",
    "down",
    "during",
    "except",
    "for",
    "from",
    "in",
    "inside",
    "into",
    "like",
    "near",
    "of",
    "off",
    "on",
    "onto",
    "out",
    "outside",
    "over",
    "past",
    "since",
    "through",
    "throughout",
    "to",
    "toward",
    "towards",
    "under",
    "underneath",
    "until",
    "up",
    "upon",
    "with",
    "within",
    "without",
}

SKIPPED = _ARTICLES | _PREPOSITIONS

# Five, as asked.
TITLE_WORDS = 5

# Airtable's single-line-text fields accept long values, but a title is read in a list view where
# anything past about this length is cut off anyway. Only ever reached by five very long words.
MAX_TITLE = 120

# A word is letters, digits and the punctuation that lives *inside* words. Apostrophes so "doesn't"
# survives as one word rather than becoming "doesn" and "t"; hyphens so "side-by-side" does;
# underscores and dots because a bug report names things like `data.paths` and `sql_table`, and those
# are the most informative words in the sentence.
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'’._-]*")


def problem_title(description: str) -> str:
    """
    The first `TITLE_WORDS` meaningful words of `description`.

    Punctuation between words is dropped, so "canvas: the zones don't dim" gives "canvas zones don't
    dim" rather than carrying a stray colon into a list view.

    Falls back to the whole (truncated) description when *every* word is skipped -- "in the on" is a
    thing a person can type, and an empty title on a record nobody can then find is worse than a
    meaningless one. Falls back to a fixed label only when there are no words at all.
    """
    text = str(description or "").strip()
    if not text:
        return "Untitled feedback"

    words = _WORD.findall(text)
    if not words:
        # Punctuation or emoji only. There is nothing to build a title from.
        return "Untitled feedback"

    kept = []
    for word in words:
        if word.lower() in SKIPPED:
            continue
        kept.append(word)
        if len(kept) == TITLE_WORDS:
            break

    if not kept:
        # Every word was a skipped one. Better a title that reads oddly than a blank cell.
        kept = words[:TITLE_WORDS]

    title = " ".join(kept)
    if len(title) <= MAX_TITLE:
        return title
    # Cut on a word boundary where there is one, so the title does not end mid-token.
    trimmed = title[:MAX_TITLE].rsplit(" ", 1)[0]
    return (trimmed or title[:MAX_TITLE]).rstrip() + "…"
