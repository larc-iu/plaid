# Summary

This is a design document for Plaid, a *platform* for application software that aims to serve language documentation and revitalization (LDR). The core belief motivating Plaid's design is that there are many people in LDR who are able to do front-end development, but very few who can handle back-end development, let alone both. Plaid therefore aims to provide the core elements that ought to be required for any LDR-y app, allowing app developers to focus on their domain logic.

# Introducing Plaid

While Plaid will hopefully solve several interrelated problems surrounding apps in LDR, there is one overriding concern: providing beginner developers with an SDK that will allow them to create real apps with minimal effort. Second after this is the goal of interoperating with external AI tools.

To accomplish these goals, Plaid is designed as a *platform*, much in the same way that [Firebase](https://en.wikipedia.org/wiki/Firebase) and [Parse](https://en.wikipedia.org/wiki/Parse,_Inc.) are platforms. A platform itself is not an app, but offers a rich API for developing apps that is much more high-level and, in our case, tailored to the specific domain we aim to serve.

A brief word on the terms **user** and **developer**. When we use these terms unaltered by context, by "developer", we will mean someone who is using Plaid as a platform and making an app off of it. By "user", we will mean someone who is using an app made by a "developer", though sometimes we will more imprecisely mean "user" as either that kind of person or a "developer".

# Data Model

The domain which Plaid must aim to serve is "any kind of linguistic analysis on any kind of language". Suffice to say that this is a sprawling domain. The most sophisticated projects which have attempted something similar to this goal have attempted to do this not by taking a kitchen sink approach and enumerating every kind of analysis, but rather, providing a modular "meta–data model" which application developers (and through apps, end users) may assemble into bespoke configurations on a per-project basis.

The basic unit by which Plaid attempts to do this is the **layer**. By composing layers of different types, users may define a data model for their annotations: for example, a user might include just one layer for POS tags if their needs are relatively simple, or they might include two layers—one for POS tags, and another for glosses. Each individual layer will then be linked to every **document** in the project.

A key decision in the Plaid approach to data modeling is to—speaking in terms of our data model, and not in terms of the natural language being described—**focus on structure** and not on meaning: we are going to model tokens, for example, but not directly encode what any particular token *means*. So how do we know whether a token represents e.g. a whole word or a morpheme? The answer is that each layer can hold interface-specific data which will allow an interface to know e.g. "this token layer is for morphemes, that token layer is for words". 

## Layers

There are five foundational kinds of layers:

* Text (foundational)  
* Token (child of text)  
* Span (child of token)  
* Relation (child of span)  
* Vocab (child of either token, span, or relation)

A layer is a schematic representation of the information that is present in a document. For each layer, every document would have instantiations of that layer:

* **Text**: exactly one for each document that holds a "body" value with the textual contents of the document as a string. The textual content should be purely surface-forms and contain no linguistic markup.  
* **Token**: a substring of the text from its dependent layer defined by begin/end indices. Tokens must not have negative length—i.e., `end - begin >= 0`.  
* **Span**: holds a value and must be associated with at least one token in the token layer that it depends on.  
* **Relation**: a directed edge between two spans. Holds a value and exactly two references to spans in the span layer the relation layer is a child of.  
* **Vocab**: unlike other layers, does not have document-level entries, and exists globally (i.e., it is available to all projects). A vocab entry has a string value called a form, which can be seen as a citation form. Each entry can then be linked to individual tokens in documents.

The goal of this system is to have the **smallest number of data types** possible while still having the **ability to express most kinds of linguistic data with minimal awkwardness**. Note that a full specification of layer types is given in Appendix A.

## Example

Let's consider an example configuration which we might use for Turkish:

* **Text**: text  
  * **Token**: morphemes  
    * **Vocab**: Turkish morphemes  
    * **Span:** POS tag  
      * **Vocab**: POS tag  
    * **Span**: English translation  
  * **Token**: words

This data model has a single text layer, two tokenizations (words and morphemes), a vocabulary backing the morphemes, a POS tag layer which also has a backing vocabulary, and a span for an English translation.

Let's consider an example document for a single Turkish sentence:

	Kemal 		gel	\-miş	  
	Kemal		come	\-PPTC  
	'Kemal has arrived.'

The single text object would look like this (for readability, I'll use a Python-ish syntax, but note that none of this is implemented in Python):

	Text(id=0, body="Kemal gelmiş")

For word-level tokenizations, we would have two tokens, with the boundaries shown:


	Kemal gelmiş  
	^   ^ ^    ^  
	0   4 6    11
	
	Token(id=1, begin=0, end=5)  
	Token(begin=6, end=12)  
	  
Morpheme tokenization would split the latter word, giving three tokenizations. These Token objects are supplemented by VMap items which encode the relation between tokens and vocabulary items. (Note that VMap's tokens attribute is a list to account for multi-word expressions.)

	Kemal gelmiş

	# In this document  
	Token(id=3, begin=0, end=5, vocab\_id="v1")  
	Token(id=4, begin=6, end=9, vocab\_id="v2")  
	Token(id=5, begin=9, end=12, vocab\_id="v3")  
	VMap(id=6, tokens=\[3\], vocab="v1")  
	VMap(id=7, tokens=\[4\], vocab="v2")  
	VMap(id=8, tokens=\[5\], vocab="v3")  
	
	# Independently of the document:  
	VocabItem(id="v1", form="Kemal", data={...})  
	VocabItem(id="v2", form="gelkar", data={...})  
	VocabItem(id="v3", form="miş", data={...})

POS tag spans would refer to tokens:  
	  
	Span(id=9, tokens=\[3\], value="NOUN")   
	Span(id=10, tokens=\[4\], value="VERB")  
	Span(id=11, tokens=\[5\], value="...")

As would the translation:

	Span(id=12, tokens=\[3,4,5\], value="Kemal has arrived.")

### Interface-specific Behavior

The above description is a *low-level* account of what happens in Plaid's internal data model. Importantly, for this model to be useful, **each user action must on average change much more than one atomic piece of data** in the data model. For example, it's probably good in this situation to provide an interface which allows a user to **simultaneously** specify morpheme and word tokenization. A very simple implementation of this might require a user to specify morpheme boundaries with a hyphen and word boundaries with whitespace. The above sentence would then look like this in its input format:

	Kemal gel-miş

A parser would then recognize two word tokens and three morpheme tokens, discarding the hyphens.

But it's very unlikely that for any piece of functionality like this, all potential users would agree on how to implement it. So how do we accommodate diverse user needs? The approach we take is two-pronged:

1. Make it easy to author new interfaces which are built on top of the core data model API and build abstractions and facilities on top of them that are purpose-appropriate.  
2. Make these interfaces *configurable* by allowing interfaces to store arbitrary data on layers to express information like "this token layer is for morphemes", or "this span layer's spans should always be mapped to exactly one token" (something you'd want for POS tags)


# NLP Support

There are multiple potential uses for NLP systems in a language documentation workflow, but the most common one is to simply provide an annotation for a certain kind in case there is not already a human-provided annotation. For example, when a new sentence is entered in a text, we might want to tokenize the new sentence with an automatic tokenizer, while still respecting some or all existing tokens.

## System Annotations

For all layers that can hold system-provided annotations, we must modify the representation of each annotation so that we may discern whether a system or a human provided it. Additionally, we will likely also want to store some metadata about the system, such as the system's ID or the confidence (as a probability percentage) of the system's output.

While it might be interesting in some situations to have a complete system-provided analysis alongside a human-provided one (some tools such as INCEpTION offer similar features), we opt for the more simple solution, which is to assume that each document has exactly one copy, and therefore that each sentence in the document has exactly one gloss, syntactic parse, etc.

## System Configuration

A major goal is to have *any* NLP system be usable with Plaid, not just a select few. NLP systems will therefore need to be registered with Plaid. This configuration would need to specify the following, at least:

* **Medium**: how will the system communicate with Plaid? Some obvious options here include the shell (for a command-line system), HTTP (for a service hosted as a service accessible at a certain IP and port), and perhaps other protocols such as gRPC.  
* **Execution model**: is the NLP system long-lived as a separate process, invoked as it is needed, run occasionally in batches, or only run when manually requested? Some models, such as tokenizers, are cheap enough they can be invoked on the command line with no concern for computational resources. Others, such as a deep neural model, might require most of the VRAM available on an expensive GPU even to be loaded and idle, and these will require more care.  
* **Input and output layers**: which layers does the model need as input for each document, and which layers is it allowed to modify? Note that this is schematic: NLP systems are registered irrespective of project.  
* **Execution conditions**: when should a document be considered "dirty" and get run again? By default, this would probably be any time an input layer is modified in a given sentence, but this logic should be overridable.

## Coordination

There are three important events in the flow of information to and from the NLP service:

1. A "triggering" write is made in Plaid which renders a sentence "dirty", i.e. in need of processing by a system.  
2. Plaid contacts the NLP system with a request for system output.  
3. The NLP system replies with new annotations which are reconciled with the current database state.

Each of these steps has some intricacies since this is a distributed process and other changes might be made in the document in the mean-time. The full description of how this system ought to function is beyond scope of this document, but note the following:

* For (1), the dirty indicators are probably most elegantly expressed as a property of the document, which could have a set attribute holding the IDs of systems which need to process the document again. (Optionally, there could be a complementary attribute which offers sentence-level dirty granularity, but that would require more care.)  
* For (3), care should be taken to ensure that the document or sentence that was processed has not changed in the meantime in a way that has invalidated the new annotations. If this happens, the update should probably simply fail, as the new update would have made the document dirty again anyway.

# Implementation and Other Design Goals

Just a sketch of this section for now:

1. The platform should be accessible via HTTP to enable easy development of web apps and possibly mobile apps. RESTfulness is not a must, but is probably a good idea.  
2. There are three major kinds of authorization which must be supported:  
   1. Superuser permission, which allows a user all access to all projects as well as the user roster.  
   2. Writer permission, which allows a user, on a per-project basis, to write and read for that project.  
   3. Reader permission, which allows a user, on a per-project basis, to read that project only with no write permissions.  
3. All historical database states should be recoverable, and something superficially similar to a Git commit history (log of changes with fully visible past states, what the diffs are, and who did what) should be visible for each document. (An immutable database such as XTDB would be well-suited for this, but if other considerations necessitate using another database, this functionality could be implemented on top of a mutable database.)  
4. Concurrent editing of any kind of data should be well-supported with no risk of data model integrity issues.  
5. Deploying an instance of Plaid should be as easy as possible for someone with minimal technical knowledge, and also very cheap or free.

# Appendix A: Layers

The data model consists of these most important entity types:

* `User`: what you'd expect  
* `Project`: a record for bundles of documents which serves as the anchor for different layer configurations  
* `Document`: a single item inside a project that will hold values associated with layers  
* `Layers` and their corresponding elements: most everything else, which we outline below

## Shared Values

* All database records have an `:id` which could either be an int or a UUID.  
* All `Layer` entities have the `:config` attribute which can host arbitrary data. This is intended for client app use in order to track any state necessary.   
* All `Layer`s have a `:name` which is a string.  
* All elements have a `:layer`, a single value which is the ID of the layer to which they belong. (Note that we often have attributes which hold an ID to another entity, and we call this a **ref**.)  
* Some elements have a `:value` attribute. For now, unless otherwise specified, we do not constrain this value at all: it should be serializable as an EDN value (so maps and sets are fine, say, but not functions), and aside from that, it can be whatever.

## Document

A document has:

* `:id`  
* `:name`  
* `:metadata`, a map of arbitrary data  
* `:media`, a URL to an audio or video BLOB for this document.

## TextLayer

A `TextLayer` is for primary text in a document. Each `Document` has exactly one `Text` per `TextLayer` at all times.

A `TextLayer` has:

* `:id`  
* `:config`  
* `:name`  
* `:token-layers`, a vector of refs of associated `TokenLayer`s.

A `Text` has:

* `:id`  
* `:layer`  
* `:document`, a ref to the corresponding `:document`  
* `:body`, a string which defaults to `""`

## TokenLayer

A `TokenLayer` is for holding `Token`s, each of which is a single substring of the corresponding `Text`. 

A `TokenLayer` has:

* `:id`  
* `:config`  
* `:name`  
* `:span-layers`, a vector of refs of associated `SpanLayer`s.

A `Token` has:

* `:id`  
* `:layer`  
* `:text`, a ref to the token's text  
* `:begin` and `:end`, both ints which define the \[inclusive, exclusive) substring bounds of `:text` which constitute this token. Note that `:begin` \<= `:end` (zero-width is OK).  
* `:end-sentence?`, a boolean attribute which when `true` indicates that the *following* token should begin a new sentence.

We might also want to provide this denormalized attributes on the basis of `:end-sentence?`:

* `:sentence-id`, an int beginning at 0 and increasing monotonically which indicates the token's sentence membership

Note that care must be taken to maintain `:sentence-id` under updates: for example, deletion of one sentence early in a document would require the decrementing of all subsequent `:sentence-id`s.

## SpanLayer

A `SpanLayer` is for holding `Span`s, each of which is a structure associated with one or more `Span`s. 

A `SpanLayer` has:

* `:id`  
* `:config`  
* `:name`  
* `:relation-layers`, a vector of refs of associated `RelationLayer`s.

A `Span` has:

* `:id`  
* `:layer`  
* `:tokens`, a vector of refs of associated `Token`s. Note that this **must** contain at least one ID, or else the span should be deleted.  
* `:value`

## TimeAlignLayer

Very similar to a `SpanLayer`, except its purpose is to hold time alignments.

A `TimeAlignLayer` has:

* `:id`  
* `:config`  
* `:name`

A `TimeAlign` has:

* `:id`  
* `:layer`  
* `:tokens`, a vector of refs of associated `Tokens`. While these tokens in practice probably ought to be perfectly contiguous, we will not enforce this in the `TimeAlign`. As with `Span`, a `TimeAlign` with no elements should be deleted.  
* `:begin` and `:end`, float values which are indexes into the media referred to by the `Document`'s `:media`.

## RelationLayer

A `RelationLayer` is for holding `Relation`s, each of which is a directed structure associating one span `:source` with another span `:target`, both in the same `SpanLayer`.

A `RelationLayer` has:

* `:id`  
* `:config`  
* `:name`

A `Relation` has:

* `:id`  
* `:layer`  
* `:source` and `:target`, two refs to valid `Span`s. If either of these is not valid, the relation should be deleted. The `:layer` of both spans must be identical.  
* `:value`

## VocabLayer

A `VocabLayer` holds `VocabItem`s, which can be used for modeling lexical entries. Unlike other layers, `VocabLayer`s are globally visible across projects. `VocabItem`s.

A `VocabLayer` has:

* `:id`  
* `:config`  
* `:name`

A `VocabItem` has:

* `:id`  
* `:form`, a unique string (relative to other items in the same vocabulary) identifying this item which could serve as a citation form.  
* `:data`, a map which can hold arbitrary data.

We additionally need a `VMap`, which is the entity that will allow us to associate `VocabItem`s with `Token`s. A `VMap` has:

* `:id`  
* `:vocab`, a ref to a `VocabLayer`.  
* `:tokens`, a vector of refs to `Token`s.
