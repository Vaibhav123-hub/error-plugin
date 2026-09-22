*&---------------------------------------------------------------------*
*& Reference implementation - not compiled/tested against a live ABAP
*& system as part of this change. Review before use: adjust the class
*& name to your registered namespace, confirm /ui2/cl_json is present
*& on your release (ships with the SAP UI5 ABAP / Gateway add-on,
*& normally already installed wherever Fiori/OData is used), and test
*& the RFC destination (see ../abap/README.md) with SM59 before wiring
*& this into any transaction.
*&---------------------------------------------------------------------*
CLASS zcl_flp_error_capture DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    "! Report one message to the FLP Error Capture service (ErrorLogService/logError).
    "! Never raises an exception itself and never changes SY-*: a reporting outage must
    "! not break the transaction that's calling it. Failures only go to the application
    "! log (SLG1, object ZFLP_ERR_CAP) so they can be investigated separately.
    "!
    "! @parameter iv_msgty          | message type: E/W/S/I/A/X (SY-MSGTY convention)
    "! @parameter iv_msgid          | message class (SY-MSGID) - pass this + iv_msgno to have
    "!                                the text built for you; leave blank if iv_message_text is set
    "! @parameter iv_msgno          | message number (SY-MSGNO)
    "! @parameter iv_msgv1..4       | message variables (SY-MSGV1..4), if msgid/msgno are used
    "! @parameter iv_message_text   | pre-built message text - use this instead of msgid/no when
    "!                                reporting from a CX_ROOT's GET_TEXT( ) or similar
    "! @parameter iv_source         | 'ABAPMessage' (classic dynpro / SAP GUI for HTML) or
    "!                                'WebDynproABAP' - see db/schema.cds source enum
    "! @parameter iv_tcode          | defaults to SY-TCODE
    "! @parameter iv_program        | defaults to SY-CPROG
    "! @parameter iv_additional_info| any extra free-text context, stored as-is
    CLASS-METHODS report_message
      IMPORTING
        iv_msgty           TYPE sy-msgty
        iv_msgid           TYPE sy-msgid OPTIONAL
        iv_msgno           TYPE sy-msgno OPTIONAL
        iv_msgv1           TYPE sy-msgv1 OPTIONAL
        iv_msgv2           TYPE sy-msgv2 OPTIONAL
        iv_msgv3           TYPE sy-msgv3 OPTIONAL
        iv_msgv4           TYPE sy-msgv4 OPTIONAL
        iv_message_text    TYPE string OPTIONAL
        iv_source          TYPE string DEFAULT 'ABAPMessage'
        iv_tcode           TYPE sy-tcode DEFAULT sy-tcode
        iv_program         TYPE sy-repid DEFAULT sy-cprog
        iv_additional_info TYPE string OPTIONAL.

    "! Convenience wrapper for a caught exception (CATCH cx_root INTO lx_error).
    CLASS-METHODS report_exception
      IMPORTING
        ix_exception TYPE REF TO cx_root
        iv_source    TYPE string DEFAULT 'ABAPMessage'
        iv_tcode     TYPE sy-tcode DEFAULT sy-tcode
        iv_program   TYPE sy-repid DEFAULT sy-cprog.

  PRIVATE SECTION.

    CONSTANTS gc_destination TYPE rfcdest VALUE 'ERRORPLUGIN_SRV'. " see abap/README.md for setup

    TYPES:
      BEGIN OF ty_error_log_entry,
        timestamp       TYPE string,
        severity        TYPE string,
        message         TYPE string,
        message_code    TYPE string,
        source          TYPE string,
        app_id          TYPE string,       " t-code, for consistent filtering alongside UI5 rows
        client          TYPE string,
        additional_info TYPE string,
        tcode           TYPE string,
        program         TYPE string,
      END OF ty_error_log_entry.

    CLASS-METHODS build_timestamp
      RETURNING VALUE(rv_timestamp) TYPE string.

    CLASS-METHODS send
      IMPORTING is_entry TYPE ty_error_log_entry.

ENDCLASS.


CLASS zcl_flp_error_capture IMPLEMENTATION.

  METHOD report_message.

    DATA(lv_text) = iv_message_text.

    " Build the interpolated message text from msgid/msgno/msgv1-4 without displaying it and
    " without touching SY-MSGTY/SY-MSGNO - this is the same FM the runtime uses internally to
    " render a MESSAGE statement's text, used here purely to read it, not to raise/show it again.
    IF lv_text IS INITIAL AND iv_msgid IS NOT INITIAL.
      CALL FUNCTION 'MESSAGE_TEXT_BUILD'
        EXPORTING
          msgid               = iv_msgid
          msgnr               = iv_msgno
          msgv1               = iv_msgv1
          msgv2               = iv_msgv2
          msgv3               = iv_msgv3
          msgv4               = iv_msgv4
        IMPORTING
          message_text_output = lv_text.
    ENDIF.

    IF lv_text IS INITIAL.
      RETURN. " nothing meaningful to report
    ENDIF.

    DATA(lv_severity) = SWITCH string( iv_msgty
      WHEN 'E' OR 'A' OR 'X' THEN 'Error'
      WHEN 'W' THEN 'Warning'
      WHEN 'S' THEN 'Success'
      WHEN 'I' THEN 'Information'
      ELSE 'Error' ).

    DATA(lv_message_code) = COND string( WHEN iv_msgid IS NOT INITIAL
      THEN |{ iv_msgid }/{ iv_msgno }| ).

    send( VALUE #(
      timestamp       = build_timestamp( )
      severity        = lv_severity
      message         = lv_text
      message_code    = lv_message_code
      source          = iv_source
      app_id          = |{ iv_tcode }|
      client          = |{ sy-mandt }|
      additional_info = iv_additional_info
      tcode           = |{ iv_tcode }|
      program         = |{ iv_program }| ) ).

  ENDMETHOD.


  METHOD report_exception.

    report_message(
      iv_msgty        = 'E'
      iv_message_text = ix_exception->get_text( )
      iv_source       = iv_source
      iv_tcode        = iv_tcode
      iv_program      = iv_program ).

  ENDMETHOD.


  METHOD build_timestamp.

    " GET TIME STAMP FIELD returns UTC (per its ABAP keyword documentation), matching the
    " Z suffix below - no separate timezone conversion needed.
    DATA lv_ts TYPE timestamp.
    GET TIME STAMP FIELD lv_ts.
    rv_timestamp = |{ lv_ts+0(4) }-{ lv_ts+4(2) }-{ lv_ts+6(2) }T{ lv_ts+8(2) }:{ lv_ts+10(2) }:{ lv_ts+12(2) }Z|.

  ENDMETHOD.


  METHOD send.

    TRY.
        DATA(lv_body) = /ui2/cl_json=>serialize(
          data        = is_entry
          pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).

        " create_by_destination reads the RFC destination's OAuth 2.0 client-credentials config
        " (Logon & Security tab in SM59) and attaches a valid Bearer token automatically - no
        " manual token handling needed here. See abap/README.md for how to set that destination up.
        DATA(lo_client) = cl_http_client=>create_by_destination( gc_destination ).

        lo_client->request->set_method( if_http_request=>co_request_method_post ).
        lo_client->request->set_header_field( name = 'Content-Type' value = 'application/json' ).
        lo_client->request->set_cdata( lv_body ).

        lo_client->send( ).
        lo_client->receive( ).

        DATA(lv_status) = lo_client->response->get_status( )-code.
        lo_client->close( ).

        IF lv_status <> 200 AND lv_status <> 201.
          " TODO: log this to your own application log (e.g. BAL_LOG_MSG_ADD to object
          " ZFLP_ERR_CAP) rather than raise - see class doc comment above for why it's
          " swallowed here instead of propagated to the caller.
        ENDIF.

      CATCH cx_root INTO DATA(lx_error). ##NO_HANDLER
        " deliberately swallowed - reporting a message must never break the caller;
        " consider logging lx_error->get_text( ) to SLG1 here for observability.
    ENDTRY.

  ENDMETHOD.

ENDCLASS.
