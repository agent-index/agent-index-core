# Agent Index Collection Exception, version 1.0

*An additional permission under section 7 of the GNU Affero General Public License, version 3.*

The Agent Index platform is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation (the "License"), together with the additional permission below. The full text of the License is in the file `LICENSE`.

## Why this exception exists

Agent Index is a platform. Everything built *on* it — the skills, tasks, coordinators, actors and workflows that do an organization's actual work — is packaged as a **collection**. The platform is use-case agnostic; the collections are where an organization's work and know-how live.

This exception keeps those two apart. The platform stays open under the AGPL: if you change the platform, you share your changes, including when you run the changed platform as a network service. Collections are yours: you may build them, keep them private, sell them, or license them however you choose, whether or not they run on the platform, and running them on the platform never puts them under the AGPL. The same goes for a storage adapter you write to connect the platform to your own storage backend.

## 0. Definitions

**"Platform"** means the software in this repository that Agent Index Inc. distributes under the License with this exception, and any work based on it.

**"Collection"** means a body of material packaged as an Agent Index collection — a directory with a `collection.json` manifest, together with the capability definitions (skills and tasks), setup templates and responses, manifests, prompts, instructions, documentation, data, templates, and bundled scripts or programs it contains — that the Platform discovers, installs, configures, reads or runs through the Collection Interfaces.

**"Collection Interfaces"** means the means the Platform documents for Collections to be discovered, installed, configured, read and run, and for Collections to call on the Platform's services. They include the `collection.json` and manifest formats, the capability-definition and setup-template formats, the setup interview and core-injected parameters, natural-language routing triggers, the remote filesystem (`aifs_*`) operations, the permission-changes procedure, and any other interface the Platform documents for use by Collections.

**"Adapter"** means a filesystem adapter — a program that implements the Agent Index filesystem adapter contract (the documented `aifs_*` operations and the `adapter.json` manifest format) so the Platform can use a storage backend — that the Platform reaches only through that contract.

**"Interface Material"** means material the Platform provides for the purpose of being copied into Collections: schemas, templates, examples, and authoring-guide samples.

**"Output"** means data, documents, records and other results produced by running the Platform or a Collection.

## 1. Additional permission for Collections

As a special exception to the License, the copyright holders of the Platform give you permission to create, use, modify, copy, distribute, convey, sell, sublicense and make available over a network any Collection, under terms of your choice, provided that the Collection interacts with the Platform only through the Collection Interfaces.

A Collection that is loaded, installed, configured, read or run by the Platform, or that calls on the Platform's services through the Collection Interfaces, is not, for that reason alone, a work based on the Platform. In particular, section 13 of the License ("Remote Network Interaction") does not require you to offer the source of a Collection to anyone who interacts with it, including when the Collection runs on a modified version of the Platform.

## 1a. Additional permission for Adapters

The same permission applies to Adapters: you may create, use, modify, copy, distribute, convey, sell, sublicense and make available over a network any Adapter, under terms of your choice, provided that it interacts with the Platform only through the filesystem adapter contract. An Adapter that the Platform calls, or that is distributed together with the Platform (for example in a bootstrap package), is not, for that reason alone, a work based on the Platform, and section 13 of the License does not require you to offer its source.

## 2. Interface Material

Interface Material that you copy into a Collection or an Adapter may be used, modified and distributed as part of it under its own terms.

## 3. What stays under the License

This exception does not apply to the Platform itself. If you modify the Platform — including by changing the Collection Interfaces or the adapter contract, or by placing Platform code in a Collection or an Adapter so that it replaces or changes the Platform's behaviour — the modified Platform is a covered work under the License, and every condition of the License applies to it, including section 13.

To the extent a Collection or an Adapter contains a copy of a part of the Platform other than Interface Material, that part remains under the License; the rest keeps the benefit of this exception.

## 4. Output

Output is not covered by the License or this exception merely because the Platform or a Collection produced it. The License covers output only where the output itself contains a covered work.

## 5. Modified versions of the Platform

If you convey a modified version of the Platform, you may extend this exception to your version, but you are not obliged to. If you do not wish to do so, delete this exception statement from your version.

## 6. No other rights

This exception grants no rights in the names, logos or trademarks of Agent Index Inc., and no rights beyond those stated above. Like the License, it comes with no warranty.

---

*Agent Index Collection Exception, version 1.0. Copyright (c) 2026 Agent Index Inc. This exception text may be copied and used to license other software.*

SPDX expression for repositories that use it: `AGPL-3.0-only WITH LicenseRef-AgentIndex-Collection-Exception-1.0`
