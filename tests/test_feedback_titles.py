"""
The derived problem title.

Worth its own file because the request's wording -- "the first five words of the description minus any
words that are articles or prepositions" -- is ambiguous between two readings that give different
answers, and the tests are where the chosen reading is pinned. See `titles.py` for why "walk until five
are kept" beats "take five, then drop some".
"""

from apps.feedback.titles import MAX_TITLE, TITLE_WORDS, problem_title


def test_it_keeps_five_meaningful_words():
    assert problem_title("Connectors overlap badly when three arrive together") == (
        "Connectors overlap badly when three"
    )


def test_it_skips_articles_and_prepositions_without_spending_the_slots():
    """
    The reading this implements, and the reason for it.

    "the event in the debugger is not shown" has four skipped words among its first five. Taking five
    and *then* dropping them yields "event debugger" -- two words from a nine-word sentence. Walking
    until five are kept yields a title someone can recognise in a list view, which is what a title is
    for.
    """
    assert problem_title("the event in the debugger is not shown") == "event debugger is not shown"


def test_it_skips_the_pronouns_the_request_pointed_at():
    """The request said "articles (the, a, an, it...)", so `it` and its neighbours count."""
    assert problem_title("it does not save the diagram after a rename") == (
        "does not save diagram rename"
    )


def test_it_keeps_words_that_merely_start_with_a_skipped_word():
    """`information` is not `in`, and `attachment` is not `at`. A prefix match would eat both."""
    assert problem_title("information attachment ordering interface onboarding") == (
        "information attachment ordering interface onboarding"
    )


def test_it_keeps_contractions_and_hyphenated_words_whole():
    """Splitting on every non-letter turns "doesn't" into "doesn" and "t", spending two slots on one word."""
    assert problem_title("side-by-side doesn't resize the divider") == (
        "side-by-side doesn't resize divider"
    )


def test_it_keeps_the_identifiers_a_bug_report_names():
    """`data.paths` and `sql_table` are the most informative words in a report like this."""
    assert problem_title("data.paths and sql_table disagree about column order") == (
        "data.paths and sql_table disagree column"
    )


def test_it_drops_punctuation_between_words():
    """Otherwise a stray colon rides into every list view."""
    assert problem_title("canvas: the zones don't dim") == "canvas zones don't dim"


def test_a_short_description_gives_a_short_title():
    assert problem_title("Zones flicker") == "Zones flicker"


def test_a_description_of_only_skipped_words_still_gets_a_title():
    """
    "in the on" is a thing a person can type. A blank title on a record nobody can then find in a list
    view is worse than one that reads oddly.
    """
    assert problem_title("in the on") == "in the on"


def test_an_empty_or_wordless_description_gets_a_label():
    for value in ["", "   ", None, "!!! ???", "😀"]:
        assert problem_title(value) == "Untitled feedback"


def test_a_very_long_title_is_cut_on_a_word_boundary():
    """Five words can still be long. Cutting mid-token reads as corruption rather than as truncation."""
    title = problem_title(" ".join(["supercalifragilistic" * 2] * 5))
    assert len(title) <= MAX_TITLE + 1  # +1 for the ellipsis
    assert title.endswith("…")
    assert "  " not in title


def test_it_takes_five_and_not_six():
    assert len(problem_title("one two three four five six seven").split()) == TITLE_WORDS


def test_case_does_not_change_whether_a_word_is_skipped():
    """A description that starts with a capital "The" is the common case, not the exception."""
    assert problem_title("The Zones In The Canvas Flicker") == "Zones Canvas Flicker"
