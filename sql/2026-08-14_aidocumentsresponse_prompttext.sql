-- Store the user prompt next to the answer, so a saved response keeps its context.
-- GNR.AIDocumentsResponse is system-versioned: ADD of a NULL column propagates to
-- AIDocumentsResponse_history automatically, no SYSTEM_VERSIONING toggle needed.
IF COL_LENGTH('GNR.AIDocumentsResponse', 'PromptText') IS NULL
    ALTER TABLE GNR.AIDocumentsResponse ADD PromptText varchar(max) NULL;
GO

-- The generic save API builds its column list from MD metadata, so the column also
-- has to be registered there. Mirrors the ResponseText row (EntityID 15818).
IF NOT EXISTS (SELECT 1 FROM MD.EntityColumn WHERE EntityID = 15818 AND ColumnName = 'prompttext')
INSERT INTO MD.EntityColumn
    (EntityID, EntityName, ColumnName, Name, Display_Name, Display_Name_he, Display_Order, Display_Order_List,
     Scaffold, ScaffoldInList, ScaffoldInNew, UIHint, isRelation, MaxLength, ColumnGroup, GroupOrder,
     ReadOnlyInMode, Calcsum, showitem, IsPII, createuserid, createdate)
VALUES
    (15818, 'AIDocumentsResponse', 'prompttext', 'PromptText', 'PromptText', N'הנחיית משתמש', 44, 44,
     1, 1, 1, 'textarea', 0, 900, 'Main', 10,
     '', 0, 0, 0, 0, GETDATE());
GO
